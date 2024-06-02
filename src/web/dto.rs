use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::models::{GamePhase as AppGamePhase, LogEntry as AppLogEntry, LogLevel as AppLogLevel, LogSource, Player, Room as AppRoom, UserType as AppUserType, Vote, VoteData};

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UserType {
    Participant,
    Spectator,
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
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LogLevel {
    Chat,
    Info,
    Error,
}


#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: LogLevel,
    pub message: String,
}

impl Into<AppLogEntry> for &LogEntry {
    fn into(self) -> AppLogEntry {
        AppLogEntry {
            timestamp: Instant::now(),
            level: match self.level {
                LogLevel::Chat => { AppLogLevel::Chat }
                LogLevel::Info => { AppLogLevel::Info }
                LogLevel::Error => { AppLogLevel::Error }
            },
            message: self.message.clone(),
            source: LogSource::Server,
            server_index: None,
        }
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
    if user.card_value == "❌" {
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
        }
    }
}

impl Into<AppUserType> for UserType {
    fn into(self) -> AppUserType {
        match self {
            UserType::Spectator => AppUserType::Spectator,
            UserType::Participant => AppUserType::Player,
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
        card_value: Option<&'a str>
    },
    ChangeName { name: &'a str },
    ChatMessage { message: &'a str },
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
            deck: vec!["1".to_string(), "2".to_string(), "3".to_string(), "5".to_string()],
            game_phase: GamePhase::Playing,
            users: vec![User {
                username: "user 1".to_string(),
                user_type: UserType::Participant,
                your_user: true,
                card_value: "13".to_string(),
            }, User {
                username: "user 2".to_string(),
                user_type: UserType::Spectator,
                your_user: false,
                card_value: "5".to_string(),
            }],
            average: "12".to_string(),
            log: vec![LogEntry {
                level: LogLevel::Chat,
                message: "Hello World".to_string(),
            }],
        }
    }

    #[test]
    fn test_request() {
        let request = UserRequest::PlayCard { card_value: Some("13") };
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
}