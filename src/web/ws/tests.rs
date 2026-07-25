use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::sync::mpsc;
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ppoker_core::client::{Client, ClientError, ClientErrorCode, Clock, ConnectionStatus};
use ppoker_core::models::GamePhase;
use tungstenite::{accept, Message, WebSocket};

use crate::config::Config;
use crate::web::ws::PokerSocket;

struct TestClock(Instant);

impl Clock for TestClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

fn server(run: impl FnOnce(WebSocket<TcpStream>) + Send + 'static) -> (Config, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let config = Config {
        server: format!("ws://{}", listener.local_addr().unwrap()),
        room: "native-production-path".to_string(),
        name: "Johnnie Waters".to_string(),
        ..Config::default()
    };
    let thread = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        run(accept(stream).unwrap());
    });
    (config, thread)
}

fn room_payload(name: &str, phase: &str, vote: &str) -> String {
    serde_json::json!({
        "roomId": "native-production-path",
        "deck": ["3", "5", "8", "13", "?"],
        "gamePhase": phase,
        "users": [{
            "username": name,
            "userType": "PARTICIPANT",
            "yourUser": true,
            "cardValue": vote
        }],
        "average": if vote.is_empty() { "0" } else { vote },
        "log": [{ "level": "INFO", "message": "joined" }]
    })
    .to_string()
}

fn client(config: &Config, socket: PokerSocket) -> Client {
    let mut client = Client::new(config.name.clone(), Rc::new(TestClock(Instant::now())));
    client.connect(Box::new(socket)).unwrap();
    client
}

fn poll_until(client: &mut Client, condition: impl Fn(&Client) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        client.poll().unwrap();
        if condition(client) {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for native socket state");
}

fn poll_until_error(client: &mut Client) -> ClientError {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match client.poll() {
            Err(error) => return error,
            Ok(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(_) => panic!("timed out waiting for native socket error"),
        }
    }
}

#[test]
fn production_socket_and_client_send_all_six_exact_commands() {
    let (requests_tx, requests_rx) = mpsc::channel();
    let (config, server) = server(move |mut socket| {
        socket
            .send(Message::Text(
                room_payload("Johnnie Waters", "PLAYING", "").into(),
            ))
            .unwrap();
        let mut requests = vec![];
        while requests.len() < 6 {
            if let Message::Text(request) = socket.read().unwrap() {
                if request.contains("RevealCards") {
                    socket
                        .send(Message::Text(
                            room_payload("Ralph Muller", "CARDS_REVEALED", "13").into(),
                        ))
                        .unwrap();
                }
                requests.push(request.to_string());
            }
        }
        requests_tx.send(requests).unwrap();
    });

    let socket = PokerSocket::connect(&config).unwrap();
    let mut client = client(&config, socket);
    poll_until(&mut client, |client| client.room().is_some());
    client.rename("Ralph Muller".to_string()).unwrap();
    client.vote("13").unwrap();
    client.retract_vote().unwrap();
    client.chat("hello".to_string()).unwrap();
    client.reveal().unwrap();
    poll_until(&mut client, |client| {
        client.room().map(|room| room.phase) == Some(GamePhase::Revealed)
    });
    client.restart().unwrap();

    assert_eq!(
        requests_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        [
            r#"{"requestType":"ChangeName","name":"Ralph Muller"}"#,
            r#"{"requestType":"PlayCard","cardValue":"13"}"#,
            r#"{"requestType":"PlayCard","cardValue":null}"#,
            r#"{"requestType":"ChatMessage","message":"hello"}"#,
            r#"{"requestType":"RevealCards"}"#,
            r#"{"requestType":"StartNewRound"}"#,
        ]
    );
    client.close();
    server.join().unwrap();
}

#[test]
fn production_socket_maps_malformed_text_and_clean_close() {
    for (payload, code, has_terminal_error) in [
        (Some("not json"), ClientErrorCode::Protocol, true),
        (None, ClientErrorCode::Closed, false),
    ] {
        let (config, server) = server(move |mut socket| {
            if let Some(payload) = payload {
                socket.send(Message::Text(payload.into())).unwrap();
                thread::sleep(Duration::from_millis(20));
            } else {
                socket.close(None).unwrap();
            }
        });

        let socket = PokerSocket::connect(&config).unwrap();
        let mut client = client(&config, socket);
        let error = poll_until_error(&mut client);
        assert_eq!(error.code, code);
        assert_eq!(client.status(), ConnectionStatus::Closed);
        assert_eq!(client.terminal_error().is_some(), has_terminal_error);
        server.join().unwrap();
    }
}

#[test]
fn production_transport_sends_the_native_keepalive_ping() {
    let (ping_tx, ping_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let (config, server) = server(move |mut socket| {
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        loop {
            if let Message::Ping(payload) = socket.read().unwrap() {
                ping_tx.send(payload.to_vec()).unwrap();
                finish_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                return;
            }
        }
    });

    let mut socket = PokerSocket::connect(&config).unwrap();
    socket.last_ping = Instant::now() - Duration::from_secs(31);
    let mut client = Client::new(config.name, Rc::new(TestClock(Instant::now())));
    client.connect(Box::new(socket)).unwrap();
    client.poll().unwrap();

    assert_eq!(
        ping_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        [0x13, 0x37]
    );
    client.close();
    finish_tx.send(()).unwrap();
    server.join().unwrap();
}
