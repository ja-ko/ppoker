use std::time::Instant;

use log::warn;
use serde::{Deserialize, Serialize};

use crate::models::{
    GamePhase as AppGamePhase, LogEntry as AppLogEntry, LogLevel as AppLogLevel, LogSource, Player,
    Room as AppRoom, UserType as AppUserType, Vote, VoteData,
};

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UserType {
    Participant,
    Spectator,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub username: String,
    pub user_type: UserType,
    pub your_user: bool,
    pub card_value: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GamePhase {
    Playing,
    CardsRevealed,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LogLevel {
    Chat,
    Info,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: LogLevel,
    pub message: String,
}

impl TryInto<AppLogEntry> for &LogEntry {
    type Error = ();

    fn try_into(self) -> Result<AppLogEntry, Self::Error> {
        let level = match self.level {
            LogLevel::Chat => AppLogLevel::Chat,
            LogLevel::Info => AppLogLevel::Info,
            LogLevel::Error => AppLogLevel::Error,
            LogLevel::Unknown => {
                warn!("Failed to convert LogLevel::Unknown to AppLogLevel");
                return Err(());
            },
        };

        Ok(AppLogEntry {
            timestamp: Instant::now(),
            level,
            message: self.message.clone(),
            source: LogSource::Server,
            server_index: None,
        })
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub room_id: String,
    pub deck: Vec<String>,
    pub game_phase: GamePhase,
    pub users: Vec<User>,
    pub average: String,
    pub log: Vec<LogEntry>,
}

fn parse_vote(user: &User) -> Vote {
    if user.card_value == "✅" {
        return Vote::Hidden;
    }
    if user.card_value == "❌" || user.card_value == "" {
        return Vote::Missing;
    }

    if user.user_type == UserType::Spectator {
        return Vote::Missing;
    }

    let parsed = user.card_value.parse::<u8>();
    return if parsed.is_err() {
        Vote::Revealed(VoteData::Special(user.card_value.clone()))
    } else {
        Vote::Revealed(VoteData::Number(parsed.unwrap()))
    };
}

impl Into<AppGamePhase> for GamePhase {
    fn into(self) -> AppGamePhase {
        match self {
            GamePhase::CardsRevealed => AppGamePhase::Revealed,
            GamePhase::Playing => AppGamePhase::Playing,
            GamePhase::Unknown => {
                warn!("Unknown GamePhase.");
                AppGamePhase::Unknown
            },
        }
    }
}

impl Into<AppUserType> for UserType {
    fn into(self) -> AppUserType {
        match self {
            UserType::Spectator => AppUserType::Spectator,
            UserType::Participant => AppUserType::Player,
            UserType::Unknown => {
                warn!("Unknown UserType.");
                AppUserType::Unknown
            },
        }
    }
}

impl Into<Player> for &User {
    fn into(self) -> Player {
        let vote = if self.your_user && self.card_value.eq("") {
            Vote::Missing
        } else {
            parse_vote(self)
        };

        Player {
            vote,
            name: self.username.clone(),
            is_you: self.your_user,
            user_type: self.user_type.into(),
        }
    }
}

impl Into<AppRoom> for &Room {
    fn into(self) -> AppRoom {
        let players = self.users.iter().map(|user| user.into()).collect();

        AppRoom {
            name: self.room_id.clone(),
            deck: self.deck.clone(),
            phase: self.game_phase.into(),
            players,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "requestType")]
pub enum UserRequest<'a> {
    PlayCard {
        #[serde(rename = "cardValue")]
        card_value: Option<&'a str>,
    },
    ChangeName {
        name: &'a str,
    },
    ChatMessage {
        message: &'a str,
    },
    RevealCards,
    StartNewRound,
}

#[cfg(test)]
mod tests {
    use assert_json_diff::assert_json_eq;
    use serde_json::json;

    use super::*;

    fn room_fixture() -> Room {
        Room {
            room_id: "roomid".to_string(),
            deck: vec![
                "1".to_string(),
                "2".to_string(),
                "3".to_string(),
                "5".to_string(),
            ],
            game_phase: GamePhase::Playing,
            users: vec![
                User {
                    username: "user 1".to_string(),
                    user_type: UserType::Participant,
                    your_user: true,
                    card_value: "13".to_string(),
                },
                User {
                    username: "user 2".to_string(),
                    user_type: UserType::Spectator,
                    your_user: false,
                    card_value: "5".to_string(),
                },
            ],
            average: "12".to_string(),
            log: vec![LogEntry {
                level: LogLevel::Chat,
                message: "Hello World".to_string(),
            }],
        }
    }

    #[test]
    fn test_request() {
        let request = UserRequest::PlayCard {
            card_value: Some("13"),
        };
        let expected = json!(
            {
              "requestType": "PlayCard",
              "cardValue": "13"
            }
        );
        assert_json_eq!(expected, request);
    }

    #[test]
    fn json_structure() {
        let room = room_fixture();

        let expected = json!(
        {
          "roomId": "roomid",
          "deck": [
            "1",
            "2",
            "3",
            "5"
          ],
          "gamePhase": "PLAYING",
          "users": [
            {
              "username": "user 1",
              "userType": "PARTICIPANT",
              "yourUser": true,
              "cardValue": "13"
            },
            {
              "username": "user 2",
              "userType": "SPECTATOR",
              "yourUser": false,
              "cardValue": "5"
            }
          ],
          "average": "12",
          "log": [
            {
              "level": "CHAT",
              "message": "Hello World"
            }
          ]
        }
                );
        println!("{}", serde_json::to_string_pretty(&room).unwrap());
        assert_json_eq!(room, expected);
    }

    #[test]
    fn test_parse_unknown_room_enum_values() {
        // Test JSON with unknown enum values
        let json_str = r#"{
          "roomId": "unknown-test",
          "deck": ["1", "2", "3"],
          "gamePhase": "UNKNOWN_PHASE",
          "users": [
            {
              "username": "user1",
              "userType": "UNKNOWN_TYPE",
              "yourUser": true,
              "cardValue": "5"
            }
          ],
          "average": "5",
          "log": []
        }"#;

        // Parse the JSON
        let room: Room = serde_json::from_str(json_str).unwrap();

        // Check that unknown values were parsed as Unknown variants
        assert_eq!(room.game_phase, GamePhase::Unknown);
        assert_eq!(room.users[0].user_type, UserType::Unknown);
        
        // Check that conversion to AppRoom works
        let app_room: AppRoom = (&room).into();
        assert_eq!(app_room.phase, AppGamePhase::Unknown);
        assert_eq!(app_room.players[0].user_type, AppUserType::Unknown);
    }

    #[test]
    fn test_unknown_log_level_is_skipped() {
        // JSON with an unknown log level
        let json_str = r#"{
          "roomId": "log-test",
          "deck": ["1", "2", "3"],
          "gamePhase": "PLAYING",
          "users": [],
          "average": "0",
          "log": [
            {
              "level": "UNKNOWN_LEVEL",
              "message": "This should be skipped"
            }
          ]
        }"#;

        let room: Room = serde_json::from_str(json_str).unwrap();
        
        // Check that log entry with unknown level exists in parsed Room
        assert_eq!(room.log.len(), 1);
        assert_eq!(room.log[0].level, LogLevel::Unknown);
        
        // But when converting to AppLogEntry, it should be skipped
        let app_log_entries: Vec<AppLogEntry> = room.log
            .iter()
            .filter_map(|entry| entry.try_into().ok())
            .collect();
            
        assert_eq!(app_log_entries.len(), 0, "LogEntry with Unknown level should be skipped");
    }

    #[test]
    fn test_mixed_log_levels_filtering() {
        // JSON with mix of valid and unknown log levels
        let json_str = r#"{
          "roomId": "mixed-logs",
          "deck": ["1", "2", "3"],
          "gamePhase": "PLAYING",
          "users": [],
          "average": "0",
          "log": [
            {
              "level": "CHAT",
              "message": "Valid chat message"
            },
            {
              "level": "UNKNOWN_LEVEL",
              "message": "This should be skipped"
            },
            {
              "level": "INFO",
              "message": "Valid info message"
            },
            {
              "level": "ERROR",
              "message": "Valid error message"
            },
            {
              "level": "ANOTHER_UNKNOWN",
              "message": "This should also be skipped"
            }
          ]
        }"#;

        let room: Room = serde_json::from_str(json_str).unwrap();
        
        // Check that all log entries exist in parsed Room
        assert_eq!(room.log.len(), 5);
        
        // But when converting to AppLogEntry, unknown levels should be skipped
        let app_log_entries: Vec<AppLogEntry> = room.log
            .iter()
            .filter_map(|entry| entry.try_into().ok())
            .collect();
            
        assert_eq!(app_log_entries.len(), 3, "Only valid LogEntries should be included");
        
        // Check that the valid messages are preserved
        assert_eq!(app_log_entries[0].message, "Valid chat message");
        assert_eq!(app_log_entries[1].message, "Valid info message");
        assert_eq!(app_log_entries[2].message, "Valid error message");
    }
}
