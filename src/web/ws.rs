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
mod tests;
