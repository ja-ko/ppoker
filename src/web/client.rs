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

#[cfg(test)]
pub mod tests {
    use super::PokerClient;
    use crate::app::AppResult;
    use crate::models::{
        GamePhase, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
    };
    use std::collections::HashMap;
    use std::time::Instant;

    #[derive(Debug, Clone)]
    struct LocalUser {
        name: String,
        vote_state: Vote,
        actual_vote: Option<String>,
    }

    #[derive(Debug)]
    pub struct LocalMockPokerClient {
        current_user: LocalUser,
        other_users: HashMap<String, LocalUser>,
        cards_revealed: bool,
        pending_updates: Vec<Room>,
        log_entries: Vec<LogEntry>,
        next_user_id: u32,
    }

    impl LocalMockPokerClient {
        pub fn new(username: &str) -> Self {
            let current_user = LocalUser {
                name: username.to_string(),
                vote_state: Vote::Missing,
                actual_vote: None,
            };

            let mut client = Self {
                current_user,
                other_users: HashMap::new(),
                cards_revealed: false,
                pending_updates: Vec::new(),
                log_entries: Vec::new(),
                next_user_id: 1,
            };

            // Create initial room state
            client.add_log_entry(&format!("{} joined the room", username));
            client.queue_room_update();

            client
        }

        fn add_log_entry(&mut self, message: &str) {
            let entry = LogEntry {
                timestamp: Instant::now(),
                level: LogLevel::Info,
                message: message.to_string(),
                source: LogSource::Server,
                server_index: Some(self.log_entries.len() as u32),
            };
            self.log_entries.push(entry);
        }

        fn queue_room_update(&mut self) {
            let mut players = vec![Player {
                name: self.current_user.name.clone(),
                vote: if let Some(vote) = &self.current_user.actual_vote {
                    // For current user, always show their own vote if they have one
                    Vote::Revealed(if let Ok(num) = vote.parse::<u8>() {
                        VoteData::Number(num)
                    } else {
                        VoteData::Special(vote.to_string())
                    })
                } else {
                    self.current_user.vote_state.clone()
                },
                is_you: true,
                user_type: UserType::Player,
            }];

            for user in self.other_users.values() {
                let vote = if self.cards_revealed {
                    if let Some(vote) = &user.actual_vote {
                        Vote::Revealed(if let Ok(num) = vote.parse::<u8>() {
                            VoteData::Number(num)
                        } else {
                            VoteData::Special(vote.to_string())
                        })
                    } else {
                        Vote::Missing
                    }
                } else {
                    user.vote_state.clone()
                };

                players.push(Player {
                    name: user.name.clone(),
                    vote,
                    is_you: false,
                    user_type: UserType::Player,
                });
            }

            let room = Room {
                name: "Planning Room".to_string(),
                deck: vec![
                    "0".to_string(),
                    "1".to_string(),
                    "2".to_string(),
                    "3".to_string(),
                    "5".to_string(),
                    "8".to_string(),
                    "13".to_string(),
                    "21".to_string(),
                    "?".to_string(),
                ],
                phase: if self.cards_revealed {
                    GamePhase::Revealed
                } else {
                    GamePhase::Playing
                },
                players,
            };

            self.pending_updates.push(room);
        }

        // Methods to simulate other users' actions
        pub fn add_user(&mut self, name: &str) -> String {
            let id = format!("user-{}", self.next_user_id);
            self.next_user_id += 1;

            let user = LocalUser {
                name: name.to_string(),
                vote_state: Vote::Missing,
                actual_vote: None,
            };

            self.other_users.insert(id.clone(), user);
            self.add_log_entry(&format!("{} joined the room", name));
            self.queue_room_update();
            id
        }
        
        #[allow(dead_code)]
        pub fn remove_user(&mut self, user_id: &str) {
            if let Some(user) = self.other_users.remove(user_id) {
                self.add_log_entry(&format!("{} left the room", user.name));
                self.queue_room_update();
            }
        }

        pub fn user_vote(&mut self, user_id: &str, card_value: Option<&str>) {
            if let Some(user) = self.other_users.get_mut(user_id) {
                let name = user.name.clone();
                user.vote_state = match card_value {
                    Some(value) => {
                        user.actual_vote = Some(value.to_string());
                        Vote::Hidden
                    }
                    None => {
                        user.actual_vote = None;
                        Vote::Missing
                    }
                };
                match &user.vote_state {
                    Vote::Hidden => self.add_log_entry(&format!("{} played a card", name)),
                    Vote::Missing => self.add_log_entry(&format!("{} removed their card", name)),
                    Vote::Revealed(_) => (), // Already revealed, no new log needed
                };
                self.queue_room_update();
            }
        }

        pub fn user_change_name(&mut self, user_id: &str, new_name: &str) {
            if let Some(user) = self.other_users.get_mut(user_id) {
                let old_name = user.name.clone();
                user.name = new_name.to_string();
                self.add_log_entry(&format!("{} changed their name to {}", old_name, new_name));
                self.queue_room_update();
            }
        }
    }

    impl PokerClient for LocalMockPokerClient {
        fn get_updates(&mut self) -> AppResult<(Vec<Room>, Vec<LogEntry>)> {
            let rooms = std::mem::take(&mut self.pending_updates);
            Ok((rooms, self.log_entries.clone()))
        }

        fn vote(&mut self, card_value: Option<&str>) -> AppResult<()> {
            let name = self.current_user.name.clone();
            self.current_user.vote_state = match card_value {
                Some(value) => {
                    self.current_user.actual_vote = Some(value.to_string());
                    Vote::Hidden
                }
                None => {
                    self.current_user.actual_vote = None;
                    Vote::Missing
                }
            };
            match &self.current_user.vote_state {
                Vote::Hidden => self.add_log_entry(&format!("{} played a card", name)),
                Vote::Missing => self.add_log_entry(&format!("{} removed their card", name)),
                Vote::Revealed(_) => (), // Already revealed, no new log needed
            };
            self.queue_room_update();
            Ok(())
        }

        fn change_name(&mut self, name: &str) -> AppResult<()> {
            let old_name = self.current_user.name.clone();
            self.current_user.name = name.to_string();
            self.add_log_entry(&format!("{} changed their name to {}", old_name, name));
            self.queue_room_update();
            Ok(())
        }

        fn chat(&mut self, message: &str) -> AppResult<()> {
            self.add_log_entry(&format!("{}: {}", self.current_user.name, message));
            self.queue_room_update();
            Ok(())
        }

        fn reveal(&mut self) -> AppResult<()> {
            if !self.cards_revealed {
                self.cards_revealed = true;

                self.add_log_entry(&format!("{} revealed all cards", self.current_user.name));
                self.queue_room_update();
            }
            Ok(())
        }

        fn reset(&mut self) -> AppResult<()> {
            self.cards_revealed = false;
            // Clear all votes
            self.current_user.vote_state = Vote::Missing;
            self.current_user.actual_vote = None;
            for user in self.other_users.values_mut() {
                user.vote_state = Vote::Missing;
                user.actual_vote = None;
            }
            self.add_log_entry(&format!("{} started a new round", self.current_user.name));
            self.queue_room_update();
            Ok(())
        }
    }

    #[test]
    fn test_mocked_voting_scenario() {
        let mut client = LocalMockPokerClient::new("Alice");

        // Add Bob
        let bob_id = client.add_user("Bob");

        // Alice votes a number
        client.vote(Some("5")).unwrap();

        // Bob votes special
        client.user_vote(&bob_id, Some("?"));

        // Get updates and verify initial state
        let (rooms, _logs) = client.get_updates().unwrap();
        let latest_room = rooms.last().unwrap();

        assert_eq!(latest_room.players.len(), 2);

        // Alice should see her own vote as revealed, but Bob's should be hidden
        assert!(matches!(
            &latest_room.players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        )); // Alice sees her vote
        assert!(matches!(&latest_room.players[1].vote, Vote::Hidden)); // Bob's vote is hidden

        // Reveal cards
        client.reveal().unwrap();

        // Get updates and verify revealed votes
        let (rooms, _) = client.get_updates().unwrap();
        let latest_room = rooms.last().unwrap();

        // Both votes should be revealed now
        assert!(matches!(
            &latest_room.players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        )); // Alice's vote
        assert!(
            matches!(&latest_room.players[1].vote, Vote::Revealed(VoteData::Special(s)) if s == "?")
        ); // Bob's actual vote

        // Start new round
        client.reset().unwrap();

        // Get updates and verify votes are cleared
        let (rooms, _) = client.get_updates().unwrap();
        let latest_room = rooms.last().unwrap();

        assert!(matches!(&latest_room.players[0].vote, Vote::Missing)); // Alice's vote cleared
        assert!(matches!(&latest_room.players[1].vote, Vote::Missing)); // Bob's vote cleared
    }

    #[test]
    fn test_moked_vote_changes() {
        let mut client = LocalMockPokerClient::new("Alice");

        // Add Bob
        let bob_id = client.add_user("Bob");

        // Alice votes "5"
        client.vote(Some("5")).unwrap();

        // Bob votes "8"
        client.user_vote(&bob_id, Some("8"));

        // Check initial state
        let (rooms, _) = client.get_updates().unwrap();
        let room = rooms.last().unwrap();
        assert!(matches!(
            &room.players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        )); // Alice sees her vote
        assert!(matches!(&room.players[1].vote, Vote::Hidden)); // Bob's vote is hidden

        // Alice changes vote to "13"
        client.vote(Some("13")).unwrap();

        // Check updated state
        let (rooms, _) = client.get_updates().unwrap();
        let room = rooms.last().unwrap();
        assert!(matches!(
            &room.players[0].vote,
            Vote::Revealed(VoteData::Number(13))
        )); // Alice's new vote
        assert!(matches!(&room.players[1].vote, Vote::Hidden)); // Bob's vote still hidden

        // Reveal cards
        client.reveal().unwrap();

        // Check final state
        let (rooms, _) = client.get_updates().unwrap();
        let room = rooms.last().unwrap();
        assert!(matches!(
            &room.players[0].vote,
            Vote::Revealed(VoteData::Number(13))
        )); // Alice's final vote
        assert!(matches!(
            &room.players[1].vote,
            Vote::Revealed(VoteData::Number(8))
        )); // Bob's revealed vote
    }

    #[test]
    fn test_chat_scenario() {
        let mut client = LocalMockPokerClient::new("Alice");

        // Add Bob
        let bob_id = client.add_user("Bob");

        // Alice sends a message
        client.chat("Hello everyone!").unwrap();

        // Bob changes name
        client.user_change_name(&bob_id, "Bobby");

        // Get updates and verify logs
        let (_, logs) = client.get_updates().unwrap();

        // Should contain 3 messages: join, chat, name change
        assert_eq!(logs.len(), 4);
        assert_eq!(logs[0].message, "Alice joined the room");
        assert_eq!(logs[1].message, "Bob joined the room");
        assert_eq!(logs[2].message, "Alice: Hello everyone!");
        assert_eq!(logs[3].message, "Bob changed their name to Bobby");
    }
}
