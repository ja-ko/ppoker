use std::thread;
use std::time::{Duration, Instant};

use log::{error, info};
use ppoker_core::client::{Clock, Session, WebPokerClient};
use snafu::Snafu;

use crate::app::AppResult;
use crate::config::Config;
use crate::web::client::ClientError::ServerUpdateMissing;
use crate::web::ws::PokerSocket;

pub use ppoker_core::client::PokerClient;

#[derive(Debug, Snafu)]
pub enum ClientError {
    #[snafu(display("Server did not send room update in time."))]
    ServerUpdateMissing,
}

pub struct NativeClock {
    baseline: Instant,
}

impl NativeClock {
    pub fn new() -> Self {
        Self {
            baseline: Instant::now(),
        }
    }
}

impl Clock for NativeClock {
    fn now(&self) -> Duration {
        self.baseline.elapsed()
    }
}

pub fn connect(config: &Config) -> AppResult<Session<Box<dyn PokerClient>>> {
    let mut result = WebPokerClient::new();
    result.connect(Box::new(PokerSocket::connect(config)?))?;
    for i in 0..20 {
        if let Some(snapshot) = result.get_update()? {
            info!("Got initial room state with delay {}ms.", i * 20);
            return Ok(Session::with_room_snapshot(
                Box::new(result),
                config.name.clone(),
                std::rc::Rc::new(NativeClock::new()),
                snapshot,
            ));
        } else {
            thread::sleep(Duration::from_millis(20));
        }
    }

    error!("Server did not send initial room update.");
    Err(Box::new(ServerUpdateMissing))
}

#[cfg(test)]
pub mod tests {
    use super::{connect, NativeClock, PokerClient};
    use crate::config::Config;
    use crate::models::{GamePhase, LogLevel, Player, Room, UserType, Vote, VoteData};
    use ppoker_core::client::{ClientResult, Session};
    use ppoker_core::protocol::{decode_room_snapshot, RoomSnapshot, ServerLogEntry};
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::thread;
    use std::time::Duration;

    #[derive(Debug, Clone)]
    struct LocalUser {
        name: String,
        vote_state: Vote,
        actual_vote: Option<String>,
        is_spectator: bool,
    }

    #[derive(Debug)]
    pub struct LocalMockPokerClient {
        current_user: LocalUser,
        other_users: HashMap<String, LocalUser>,
        cards_revealed: bool,
        pending_updates: Vec<Room>,
        log_entries: Vec<ServerLogEntry>,
        next_user_id: u32,
    }

    impl LocalMockPokerClient {
        pub fn add_spectator(&mut self, username: &str) -> String {
            let user_id = format!("user_{}", self.next_user_id);
            self.next_user_id += 1;

            let user = LocalUser {
                name: username.to_string(),
                vote_state: Vote::Missing,
                actual_vote: None,
                is_spectator: true,
            };

            self.other_users.insert(user_id.clone(), user);
            self.add_log_entry(&format!("{} joined as spectator", username));
            self.queue_room_update();

            user_id
        }

        pub fn new(username: &str) -> Self {
            let current_user = LocalUser {
                name: username.to_string(),
                vote_state: Vote::Missing,
                actual_vote: None,
                is_spectator: false,
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
            let entry = ServerLogEntry {
                level: LogLevel::Info,
                message: message.to_string(),
                server_index: self.log_entries.len() as u32,
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
                user_type: if self.current_user.is_spectator {
                    UserType::Spectator
                } else {
                    UserType::Player
                },
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
                    user_type: if user.is_spectator {
                        UserType::Spectator
                    } else {
                        UserType::Player
                    },
                });
            }

            // Sort players so spectators appear after players
            players.sort_by_key(|p| match p.user_type {
                UserType::Player => 0,
                UserType::Spectator => 1,
                UserType::Unknown => 2,
            });

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
                is_spectator: false,
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
        fn ensure_ready(&self) -> ClientResult<()> {
            Ok(())
        }

        fn get_updates(&mut self) -> ClientResult<Vec<RoomSnapshot>> {
            let rooms = std::mem::take(&mut self.pending_updates);
            Ok(rooms
                .into_iter()
                .map(|room| RoomSnapshot {
                    room,
                    log: self.log_entries.clone(),
                })
                .collect())
        }

        fn vote(&mut self, card_value: &str) -> ClientResult<()> {
            let name = self.current_user.name.clone();
            self.current_user.actual_vote = Some(card_value.to_string());
            self.current_user.vote_state = Vote::Hidden;
            self.add_log_entry(&format!("{} played a card", name));
            self.queue_room_update();
            Ok(())
        }

        fn retract_vote(&mut self) -> ClientResult<()> {
            let name = self.current_user.name.clone();
            self.current_user.actual_vote = None;
            self.current_user.vote_state = Vote::Missing;
            self.add_log_entry(&format!("{} removed their card", name));
            self.queue_room_update();
            Ok(())
        }

        fn change_name(&mut self, name: &str) -> ClientResult<()> {
            let old_name = self.current_user.name.clone();
            self.current_user.name = name.to_string();
            self.add_log_entry(&format!("{} changed their name to {}", old_name, name));
            self.queue_room_update();
            Ok(())
        }

        fn chat(&mut self, message: &str) -> ClientResult<()> {
            self.add_log_entry(&format!("{}: {}", self.current_user.name, message));
            self.queue_room_update();
            Ok(())
        }

        fn reveal(&mut self) -> ClientResult<()> {
            if !self.cards_revealed {
                self.cards_revealed = true;

                self.add_log_entry(&format!("{} revealed all cards", self.current_user.name));
                self.queue_room_update();
            }
            Ok(())
        }

        fn reset(&mut self) -> ClientResult<()> {
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

        fn close(&mut self) {}
    }

    struct SnapshotPokerClient(Vec<RoomSnapshot>);

    impl PokerClient for SnapshotPokerClient {
        fn ensure_ready(&self) -> ClientResult<()> {
            Ok(())
        }

        fn get_updates(&mut self) -> ClientResult<Vec<RoomSnapshot>> {
            Ok(std::mem::take(&mut self.0))
        }

        fn vote(&mut self, _card_value: &str) -> ClientResult<()> {
            unreachable!()
        }

        fn retract_vote(&mut self) -> ClientResult<()> {
            unreachable!()
        }

        fn change_name(&mut self, _name: &str) -> ClientResult<()> {
            unreachable!()
        }

        fn chat(&mut self, _message: &str) -> ClientResult<()> {
            unreachable!()
        }

        fn reveal(&mut self) -> ClientResult<()> {
            unreachable!()
        }

        fn reset(&mut self) -> ClientResult<()> {
            unreachable!()
        }

        fn close(&mut self) {}
    }

    #[test]
    fn unknown_log_level_does_not_collide_with_an_appended_log() {
        let initial = decode_room_snapshot(
            r#"{
                "roomId":"log-room",
                "deck":[],
                "gamePhase":"PLAYING",
                "users":[],
                "average":"0",
                "log":[
                    {"level":"INFO","message":"first"},
                    {"level":"FUTURE_LEVEL","message":"unknown"},
                    {"level":"CHAT","message":"third"}
                ]
            }"#,
        )
        .unwrap();
        let appended = decode_room_snapshot(
            r#"{
                "roomId":"log-room",
                "deck":[],
                "gamePhase":"PLAYING",
                "users":[],
                "average":"0",
                "log":[
                    {"level":"INFO","message":"first"},
                    {"level":"FUTURE_LEVEL","message":"unknown"},
                    {"level":"CHAT","message":"third"},
                    {"level":"INFO","message":"appended"}
                ]
            }"#,
        )
        .unwrap();
        let mut session = Session::new(
            SnapshotPokerClient(vec![initial, appended]),
            "Alice".to_string(),
            Rc::new(NativeClock::new()),
        );
        session.update().unwrap();

        assert_eq!(
            session
                .log()
                .iter()
                .map(|entry| (entry.server_index, entry.message.as_str()))
                .collect::<Vec<_>>(),
            [
                (Some(0), "first"),
                (Some(2), "third"),
                (Some(3), "appended")
            ]
        );
    }

    #[test]
    fn test_mocked_voting_scenario() {
        let mut client = LocalMockPokerClient::new("Alice");

        // Add Bob
        let bob_id = client.add_user("Bob");

        // Alice votes a number
        client.vote("5").unwrap();

        // Bob votes special
        client.user_vote(&bob_id, Some("?"));

        // Get updates and verify initial state
        let rooms = client.get_updates().unwrap();
        let latest_room = &rooms.last().unwrap().room;

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
        let rooms = client.get_updates().unwrap();
        let latest_room = &rooms.last().unwrap().room;

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
        let rooms = client.get_updates().unwrap();
        let latest_room = &rooms.last().unwrap().room;

        assert!(matches!(&latest_room.players[0].vote, Vote::Missing)); // Alice's vote cleared
        assert!(matches!(&latest_room.players[1].vote, Vote::Missing)); // Bob's vote cleared
    }

    #[test]
    fn test_moked_vote_changes() {
        let mut client = LocalMockPokerClient::new("Alice");

        // Add Bob
        let bob_id = client.add_user("Bob");

        // Alice votes "5"
        client.vote("5").unwrap();

        // Bob votes "8"
        client.user_vote(&bob_id, Some("8"));

        // Check initial state
        let rooms = client.get_updates().unwrap();
        let room = &rooms.last().unwrap().room;
        assert!(matches!(
            &room.players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        )); // Alice sees her vote
        assert!(matches!(&room.players[1].vote, Vote::Hidden)); // Bob's vote is hidden

        // Alice changes vote to "13"
        client.vote("13").unwrap();

        // Check updated state
        let rooms = client.get_updates().unwrap();
        let room = &rooms.last().unwrap().room;
        assert!(matches!(
            &room.players[0].vote,
            Vote::Revealed(VoteData::Number(13))
        )); // Alice's new vote
        assert!(matches!(&room.players[1].vote, Vote::Hidden)); // Bob's vote still hidden

        // Reveal cards
        client.reveal().unwrap();

        // Check final state
        let rooms = client.get_updates().unwrap();
        let room = &rooms.last().unwrap().room;
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
        let updates = client.get_updates().unwrap();
        let logs = &updates.last().unwrap().log;

        // Should contain 3 messages: join, chat, name change
        assert_eq!(logs.len(), 4);
        assert_eq!(logs[0].message, "Alice joined the room");
        assert_eq!(logs[1].message, "Bob joined the room");
        assert_eq!(logs[2].message, "Alice: Hello everyone!");
        assert_eq!(logs[3].message, "Bob changed their name to Bobby");
    }

    #[test]
    fn test_voting_and_chat() {
        let config = Config::default();
        let mut client1 = connect(&config).expect("Failed to create client 1");
        let mut client2 = connect(&config).expect("Failed to create client 2");

        // Let's have client1 vote and send a chat message
        client1.vote("5").expect("Failed to vote");
        client1
            .chat("Hello from client 1!".to_string())
            .expect("Failed to send chat");
        // Work around a race condition in the server.
        thread::sleep(Duration::from_millis(10));
        // Client2 votes as well
        client2.vote("3").expect("Failed to vote");

        // Small delay to ensure messages are processed
        thread::sleep(Duration::from_millis(250));

        // Get updates for both clients
        client1
            .update()
            .expect("Failed to get updates for client 1");
        client2
            .update()
            .expect("Failed to get updates for client 2");

        // Check room state - use the last update as it represents the final state
        let room = client1.room().expect("Expected a room1 update");
        let room2 = client2.room().expect("Expected a room2 update");
        assert_eq!(room.players.len(), 2, "Expected 2 users in the room");

        // Find client1's vote
        let client1_user = room
            .players
            .iter()
            .find(|u| u.is_you)
            .expect("Couldn't find self in players");
        assert_eq!(
            client1_user.vote,
            Vote::Revealed(VoteData::Number(5)),
            "Client 1's vote not correctly reflected"
        );

        // Find client2's vote
        let client2_user = room2
            .players
            .iter()
            .find(|u| u.is_you)
            .expect("Couldn't find other player");

        assert_eq!(
            client2_user.vote,
            Vote::Revealed(VoteData::Number(3)),
            "Client 2's vote not correctly reflected"
        );

        // Check chat messages - use the last log as it should contain our message
        let logs1 = client1.log();
        assert!(!logs1.is_empty(), "Expected at least one chat message");
        assert!(
            logs1[logs1.len() - 1]
                .message
                .contains("Hello from client 1!"),
            "Chat message not found in log entries"
        );

        // Both clients should see the same final room state
        assert_eq!(
            room.players.len(),
            room2.players.len(),
            "Room state inconsistent between clients"
        );
    }
}
