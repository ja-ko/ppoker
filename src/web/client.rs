use std::thread;
use std::time::Duration;

use log::{error, info};
use snafu::Snafu;

use crate::app::AppResult;
use crate::config::Config;
use crate::models::{LogEntry, Room};
use crate::web::client::ClientError::{ServerClosedConnection, ServerUpdateMissing};
use crate::web::dto::UserRequest;
use crate::web::ws::{IncomingMessage, PokerSocket};

#[derive(Debug, Snafu)]
pub enum ClientError {
    #[snafu(display("Server did not send room update in time."))]
    ServerUpdateMissing,
    #[snafu(display("Server closed connection."))]
    ServerClosedConnection,
}

#[cfg_attr(test, mockall::automock)]
pub trait PokerClient {
    fn get_updates(&mut self) -> AppResult<(Vec<Room>, Vec<LogEntry>)>;
    fn vote<'a>(&mut self, card_value: Option<&'a str>) -> AppResult<()>;
    fn change_name<'a>(&mut self, name: &'a str) -> AppResult<()>;
    fn chat<'a>(&mut self, message: &'a str) -> AppResult<()>;
    fn reveal(&mut self) -> AppResult<()>;
    fn reset(&mut self) -> AppResult<()>;
}

#[derive(Debug)]
pub struct WebPokerClient {
    pub socket: PokerSocket,
}

impl WebPokerClient {
    pub fn new(config: &Config) -> AppResult<(Self, Room, Vec<LogEntry>)> {
        let mut result = Self {
            socket: PokerSocket::connect(config)?,
        };
        for i in 0..20 {
            let room_update = result.socket.read()?;
            if let Some(IncomingMessage::RoomUpdate(room)) = room_update {
                info!("Got initial room state with delay {}ms.", i * 20);
                return Ok((
                    result,
                    (&room).into(),
                    (&room.log)
                        .iter()
                        .enumerate()
                        .map(|(i, l)| {
                            let mut result: LogEntry = l.into();
                            result.server_index = Some(i as u32);
                            result
                        })
                        .collect(),
                ));
            } else {
                thread::sleep(Duration::from_millis(20));
            }
        }

        error!("Server did not send initial room update.");
        return Err(Box::new(ServerUpdateMissing));
    }
}

impl PokerClient for WebPokerClient {

    fn get_updates(&mut self) -> AppResult<(Vec<Room>, Vec<LogEntry>)> {
        let messages = self.socket.read_all()?;
        let mut result = vec![];
        let mut log_results = vec![];

        for message in messages {
            match &message {
                IncomingMessage::Close => {
                    info!("Server closed connection. Terminating.");
                    return Err(Box::new(ServerClosedConnection));
                }
                IncomingMessage::RoomUpdate(room) => {
                    let logs: Vec<LogEntry> = room.log.iter().map(|l| l.into()).collect();
                    for i in 0..logs.len() {
                        if log_results.len() == i {
                            let mut entry = logs[i].clone();
                            entry.server_index = Some(i as u32);
                            log_results.push(entry);
                        }
                    }
                    result.push(room.into());
                }
            }
        }

        Ok((result, log_results))
    }

    fn vote(&mut self, card_value: Option<&str>) -> AppResult<()> {
        self.socket
            .send_request(UserRequest::PlayCard { card_value })?;

        Ok(())
    }

    fn change_name(&mut self, name: &str) -> AppResult<()> {
        self.socket.send_request(UserRequest::ChangeName { name })
    }

    fn chat(&mut self, message: &str) -> AppResult<()> {
        self.socket
            .send_request(UserRequest::ChatMessage { message })
    }

    fn reveal(&mut self) -> AppResult<()> {
        self.socket.send_request(UserRequest::RevealCards)
    }

    fn reset(&mut self) -> AppResult<()> {
        self.socket.send_request(UserRequest::StartNewRound)
    }
}
