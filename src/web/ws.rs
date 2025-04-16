use std::net::TcpStream;
use std::time::{Duration, Instant};

use log::{debug, info};
use tungstenite::{Message, WebSocket};
use tungstenite::stream::MaybeTlsStream;

use crate::app::AppResult;
use crate::config::Config;
use crate::web::dto::{Room, UserRequest};

#[derive(Debug)]
pub struct PokerSocket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    last_ping: Instant,
}

#[derive(Debug)]
pub enum IncomingMessage {
    Close,
    RoomUpdate(Room),
}

impl PokerSocket {
    pub fn connect(config: &Config) -> AppResult<Self> {
        let url = format!("{}/rooms/{}?user={}&userType=PARTICIPANT", config.server, urlencoding::encode(config.room.as_str()), urlencoding::encode(config.name.as_str()));
        let (mut socket, _response) = tungstenite::connect(url)?;
        match socket.get_mut() {
            MaybeTlsStream::NativeTls(t) => {
                let stream = t.get_mut();
                stream.set_nonblocking(true).expect("Unable to switch stream to nonblocking mode");
            }
            MaybeTlsStream::Plain(t) => {
                t.set_nonblocking(true).expect("Unable to switch stream to nonblocking mode");
            }
            _ => {}
        }
        info!("Socket connection established.");

        Ok(Self {
            socket,
            last_ping: Instant::now(),
        })
    }

    pub fn send_request(&mut self, request: UserRequest) -> AppResult<()> {
        let body = serde_json::to_string(&request)?;
        debug!("Sending message: {:?}", body);
        self.socket.send(Message::Text(body.into()))?;
        Ok(())
    }

    pub fn read(&mut self) -> AppResult<Option<IncomingMessage>> {
        if Instant::now() - self.last_ping > Duration::from_secs(30) {
            self.ping()?;
        }
        let result = self.socket.read();
        if let Err(tungstenite::Error::Io(e)) = &result {
            if e.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
        }
        let message = result?;
        match message {
            Message::Text(text) => {
                debug!("Got message from server: {}", text);
                return Ok(Some(IncomingMessage::RoomUpdate(serde_json::from_str(&text)?)));
            }
            Message::Binary(_) => {}
            Message::Ping(d) => {
                debug!("Ping: {:?}", d);
            }
            Message::Pong(d) => {
                debug!("Pong: {:?}", d)
            }
            Message::Close(_) => {
                debug!("Server closed connection.");
                return Ok(Some(IncomingMessage::Close));
            }
            Message::Frame(_) => {}
        }
        Ok(None)
    }

    pub fn read_all(&mut self) -> AppResult<Vec<IncomingMessage>> {
        let mut result = vec![];
        loop {
            let message = self.read()?;
            if let Some(message) = message {
                result.push(message);
            } else {
                return Ok(result);
            }
        }
    }

    pub fn ping(&mut self) -> AppResult<()> {
        self.socket.send(Message::Ping(vec![0x13, 0x37].into()))?;
        self.last_ping = Instant::now();

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;

    use pretty_assertions::assert_matches;

    use crate::app::AppResult;
    use crate::config::Config;
    use crate::web::dto::{GamePhase, UserRequest, UserType};
    use crate::web::ws::{IncomingMessage, PokerSocket};

    fn get_config() -> Config {
        let mut config = Config::default();
        config.name = "Johnnie Waters".to_owned();
        return config;
    }

    #[test]
    fn connect() {
        let mut client = PokerSocket::connect(&get_config()).unwrap();
        thread::sleep(Duration::from_millis(250));
        let message = client.read().unwrap();
        if let Some(message) = message {
            assert_matches!(message, IncomingMessage::RoomUpdate(_));
        } else {
            panic!("Didn't get an update from server.");
        }
    }

    #[test]
    fn send_commands() -> AppResult<()> {
        let config = get_config();
        let mut client = PokerSocket::connect(&config).unwrap();
        thread::sleep(Duration::from_millis(250));
        let messages = client.read_all().unwrap();
        assert_eq!(messages.len(), 1);

        assert_matches!(&messages[0], IncomingMessage::RoomUpdate(room) if room.room_id.eq(&config.room));
        let room = if let IncomingMessage::RoomUpdate(room) = &messages[0] { room } else { panic!("Shouldn't happen.") };
        assert_eq!(room.users[0].your_user, true);
        assert_eq!(room.users[0].username, "Johnnie Waters");
        assert_eq!(room.users[0].user_type, UserType::Participant);

        client.send_request(UserRequest::ChangeName { name: "Ralph Muller" }).unwrap();
        thread::sleep(Duration::from_millis(250));
        let messages = client.read_all().unwrap();
        assert_eq!(messages.len(), 1);

        assert_matches!(&messages[0], IncomingMessage::RoomUpdate(room) if room.room_id.eq(&config.room));
        let room = if let IncomingMessage::RoomUpdate(room) = &messages[0] { room } else { panic!("Shouldn't happen.") };
        assert_eq!(room.users[0].your_user, true);
        assert_eq!(room.users[0].username, "Ralph Muller");

        client.send_request(UserRequest::PlayCard { card_value: Some("13") }).unwrap();
        client.send_request(UserRequest::RevealCards).unwrap();

        thread::sleep(Duration::from_millis(250));
        let messages = client.read_all().unwrap();
        assert_eq!(messages.len(), 2);
        assert_matches!(&messages[0], IncomingMessage::RoomUpdate(room) if room.room_id.eq(&config.room));
        let room = if let IncomingMessage::RoomUpdate(room) = &messages[0] { room } else { panic!("Shouldn't happen.") };
        assert_eq!(room.users[0].your_user, true);
        assert_eq!(room.users[0].card_value, "13");

        assert_matches!(&messages[1], IncomingMessage::RoomUpdate(room) if room.room_id.eq(&config.room));
        let room = if let IncomingMessage::RoomUpdate(room) = &messages[1] { room } else { panic!("Shouldn't happen.") };
        assert_eq!(room.game_phase, GamePhase::CardsRevealed);

        Ok(())
    }

    #[test]
    fn change_vote() -> AppResult<()> {
        let config1 = get_config();
        let mut config2 = config1.clone();
        config2.name = "Ralph Muller".to_string();

        let mut client1 = PokerSocket::connect(&config1).unwrap();
        let mut client2 = PokerSocket::connect(&config2).unwrap();
        client1.send_request(UserRequest::PlayCard { card_value: Some("5") })?;
        client2.send_request(UserRequest::PlayCard { card_value: Some("8") })?;

        thread::sleep(Duration::from_millis(200));

        client1.read_all()?;
        client2.read_all()?;

        client1.send_request(UserRequest::PlayCard { card_value: None })?;

        thread::sleep(Duration::from_millis(200));

        let client1_messages = client1.read_all()?;
        let client2_messages = client2.read_all()?;

        println!("Client 1: {:?}", client1_messages);
        println!("Client 2: {:?}", client2_messages);

        let message = &client2_messages[client2_messages.len() - 1];
        if let IncomingMessage::RoomUpdate(room) = message {
            assert_eq!(room.users.iter().find(|p| p.username == "Johnnie Waters").unwrap().card_value, "❌");
        } else {
            panic!("Wrong packet type.");
        };

        let message = &client1_messages[client1_messages.len() - 1];
        if let IncomingMessage::RoomUpdate(room) = message {
            assert_eq!(room.users.iter().find(|p| p.username == "Johnnie Waters").unwrap().card_value, "");
        } else {
            panic!("Wrong packet type.");
        };


        Ok(())
    }
}