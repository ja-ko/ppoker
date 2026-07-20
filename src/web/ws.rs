use std::net::TcpStream;
use std::time::{Duration, Instant};

use log::{debug, info};
use ppoker_core::client::{Transport, TransportEvent};
use ppoker_core::protocol::{build_room_url, ConnectionRole};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::app::AppResult;
use crate::config::Config;

#[derive(Debug)]
pub struct PokerSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    last_ping: Instant,
    opened_pending: bool,
}

impl PokerSocket {
    pub fn connect(config: &Config) -> AppResult<Self> {
        let url = build_room_url(
            &config.server,
            &config.room,
            &config.name,
            ConnectionRole::Participant,
        )?;
        let (mut socket, _response) = tungstenite::connect(url)?;
        match socket.get_mut() {
            MaybeTlsStream::NativeTls(t) => {
                let stream = t.get_mut();
                stream
                    .set_nonblocking(true)
                    .expect("Unable to switch stream to nonblocking mode");
            }
            MaybeTlsStream::Plain(t) => {
                t.set_nonblocking(true)
                    .expect("Unable to switch stream to nonblocking mode");
            }
            _ => {}
        }
        info!("Socket connection established.");

        Ok(Self {
            socket,
            last_ping: Instant::now(),
            opened_pending: true,
        })
    }

    fn ping(&mut self) -> tungstenite::Result<()> {
        self.socket.send(Message::Ping(vec![0x13, 0x37].into()))?;
        self.last_ping = Instant::now();

        Ok(())
    }
}

impl Transport for PokerSocket {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        if self.opened_pending {
            self.opened_pending = false;
            return Some(TransportEvent::Opened);
        }
        if Instant::now() - self.last_ping > Duration::from_secs(30) {
            if let Err(error) = self.ping() {
                return Some(TransportEvent::Error(error.to_string()));
            }
        }

        match self.socket.read() {
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                None
            }
            Err(error) => Some(TransportEvent::Error(error.to_string())),
            Ok(Message::Text(text)) => {
                debug!("Got message from server: {}", text);
                Some(TransportEvent::Text(text.to_string()))
            }
            Ok(Message::Binary(data)) => Some(TransportEvent::Binary { length: data.len() }),
            Ok(Message::Close(_)) => {
                debug!("Server closed connection.");
                Some(TransportEvent::Closed)
            }
            Ok(Message::Ping(data)) => {
                debug!("Ping: {:?}", data);
                None
            }
            Ok(Message::Pong(data)) => {
                debug!("Pong: {:?}", data);
                None
            }
            Ok(Message::Frame(_)) => None,
        }
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        debug!("Sending message: {:?}", message);
        self.socket
            .send(Message::Text(message.into()))
            .map_err(|error| error.to_string())
    }

    fn close(&mut self) {
        let _ = self.socket.close(None);
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::rc::Rc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use ppoker_core::client::{
        ClientError, ClientErrorCode, Clock, ConnectionStatus, Session, WebPokerClient,
    };
    use ppoker_core::models::{GamePhase, UserType, Vote, VoteData};
    use tungstenite::{accept, Message};

    use crate::config::Config;
    use crate::web::ws::PokerSocket;

    struct TestClock(Instant);

    impl Clock for TestClock {
        fn now(&self) -> Duration {
            self.0.elapsed()
        }
    }

    fn config_for(listener: &TcpListener) -> Config {
        let mut config = Config::default();
        config.server = format!("ws://{}", listener.local_addr().unwrap());
        config.room = "native-production-path".to_string();
        config.name = "Johnnie Waters".to_string();
        config
    }

    fn room_payload(name: &str, phase: &str, vote: &str) -> String {
        let average = if vote.is_empty() { "0" } else { vote };
        format!(
            r#"{{"roomId":"native-production-path","deck":["3","5","8","13","?"],"gamePhase":"{phase}","users":[{{"username":"{name}","userType":"PARTICIPANT","yourUser":true,"cardValue":"{vote}"}}],"average":"{average}","log":[{{"level":"INFO","message":"joined"}}]}}"#
        )
    }

    fn session(config: &Config, socket: PokerSocket) -> Session<WebPokerClient> {
        let mut session = Session::new(
            WebPokerClient::new(),
            config.name.clone(),
            Rc::new(TestClock(Instant::now())),
        );
        session.connect(Box::new(socket)).unwrap();
        session
    }

    fn update_until(
        session: &mut Session<WebPokerClient>,
        condition: impl Fn(&Session<WebPokerClient>) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            session.update().unwrap();
            if condition(session) {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for a production client update");
    }

    fn update_until_error(session: &mut Session<WebPokerClient>) -> ClientError {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match session.update() {
                Ok(_) => thread::sleep(Duration::from_millis(5)),
                Err(error) => return error,
            }
        }
        panic!("timed out waiting for a production client error");
    }

    #[test]
    fn production_path_connects_decodes_snapshots_and_sends_all_commands() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = config_for(&listener);
        let (requests_tx, requests_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
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
        let mut client = session(&config, socket);
        update_until(&mut client, |session| session.room().is_some());
        let room = client.room().unwrap();
        assert_eq!(client.status(), ConnectionStatus::Open);
        assert_eq!(room.name, config.room);
        assert_eq!(room.players[0].name, "Johnnie Waters");
        assert!(room.players[0].is_you);
        assert_eq!(room.players[0].user_type, UserType::Player);
        assert_eq!(client.log()[0].message, "joined");

        client.rename("Ralph Muller".to_string()).unwrap();
        client.vote("13").unwrap();
        client.retract_vote().unwrap();
        client.chat("hello".to_string()).unwrap();
        client.reveal().unwrap();
        update_until(&mut client, |session| {
            session.room().map(|room| room.phase) == Some(GamePhase::Revealed)
        });
        assert_eq!(
            client.room().unwrap().players[0].vote,
            Vote::Revealed(VoteData::Number(13))
        );
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
        assert!(client.close());
        assert!(!client.close());
        server.join().unwrap();
    }

    #[test]
    fn production_path_maps_protocol_failures_and_remote_close_terminally() {
        for (payload, expected_code, terminal_error) in [
            (Some("not json"), ClientErrorCode::Protocol, true),
            (None, ClientErrorCode::Closed, false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let config = config_for(&listener);
            let server = thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut socket = accept(stream).unwrap();
                if let Some(payload) = payload {
                    socket.send(Message::Text(payload.into())).unwrap();
                    let _ = socket.read();
                } else {
                    socket.close(None).unwrap();
                }
            });

            let socket = PokerSocket::connect(&config).unwrap();
            let mut client = session(&config, socket);
            let error = update_until_error(&mut client);
            assert_eq!(error.code, expected_code);
            assert_eq!(client.status(), ConnectionStatus::Closed);
            assert_eq!(client.terminal_error().is_some(), terminal_error);
            assert!(!client.close());
            server.join().unwrap();
        }
    }

    #[test]
    fn production_transport_sends_the_native_keepalive_ping() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = config_for(&listener);
        let (ping_tx, ping_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut socket = accept(stream).unwrap();
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
        let mut client = Session::new(
            WebPokerClient::new(),
            config.name,
            Rc::new(TestClock(Instant::now())),
        );
        client.connect(Box::new(socket)).unwrap();
        client.update().unwrap();

        assert_eq!(
            ping_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            [0x13, 0x37]
        );
        client.close();
        finish_tx.send(()).unwrap();
        server.join().unwrap();
    }
}
