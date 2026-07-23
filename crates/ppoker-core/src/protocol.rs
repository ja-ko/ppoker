use std::error::Error;
use std::fmt::{Display, Formatter};

use log::warn;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::models::{
    GamePhase as AppGamePhase, LogLevel as AppLogLevel, Player, Room as AppRoom,
    UserType as AppUserType, Vote, VoteData,
};

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Copy, Clone)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum ConnectionRole {
    Participant,
    Spectator,
}

#[derive(Debug, PartialEq, Clone)]
pub struct ServerLogEntry {
    pub server_index: u32,
    pub level: AppLogLevel,
    pub message: String,
}

#[derive(Debug, PartialEq, Clone)]
pub struct RoomSnapshot {
    pub room: AppRoom,
    pub log: Vec<ServerLogEntry>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RoomUrlError {
    InvalidUrl(url::ParseError),
    InvalidRoom,
    UnsupportedScheme,
    CredentialsNotAllowed,
    QueryNotAllowed,
    FragmentNotAllowed,
    InvalidBaseUrl,
}

impl Display for RoomUrlError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(error) => write!(formatter, "invalid WebSocket URL: {error}"),
            Self::InvalidRoom => formatter.write_str("Room must not be `.` or `..`."),
            Self::UnsupportedScheme => {
                formatter.write_str("WebSocket URL scheme must be ws or wss")
            }
            Self::CredentialsNotAllowed => {
                formatter.write_str("WebSocket URL must not contain credentials")
            }
            Self::QueryNotAllowed => {
                formatter.write_str("WebSocket base URL must not contain a query")
            }
            Self::FragmentNotAllowed => {
                formatter.write_str("WebSocket base URL must not contain a fragment")
            }
            Self::InvalidBaseUrl => {
                formatter.write_str("WebSocket URL cannot be used as an absolute base URL")
            }
        }
    }
}

impl RoomUrlError {
    pub fn field(&self) -> &'static str {
        match self {
            Self::InvalidRoom => "room",
            _ => "endpoint",
        }
    }
}

impl Error for RoomUrlError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidUrl(error) => Some(error),
            _ => None,
        }
    }
}

impl From<url::ParseError> for RoomUrlError {
    fn from(error: url::ParseError) -> Self {
        Self::InvalidUrl(error)
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum UserType {
    Participant,
    Spectator,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct User {
    username: String,
    user_type: UserType,
    your_user: bool,
    card_value: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum GamePhase {
    Playing,
    CardsRevealed,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Copy, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum LogLevel {
    Chat,
    Info,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    level: LogLevel,
    message: String,
}

impl TryInto<ServerLogEntry> for &LogEntry {
    type Error = ();

    fn try_into(self) -> Result<ServerLogEntry, Self::Error> {
        let level = match self.level {
            LogLevel::Chat => AppLogLevel::Chat,
            LogLevel::Info => AppLogLevel::Info,
            LogLevel::Error => AppLogLevel::Error,
            LogLevel::Unknown => {
                warn!("Failed to convert LogLevel::Unknown to AppLogLevel");
                return Err(());
            }
        };

        Ok(ServerLogEntry {
            server_index: 0,
            level,
            message: self.message.clone(),
        })
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Room {
    room_id: String,
    deck: Vec<String>,
    game_phase: GamePhase,
    users: Vec<User>,
    average: String,
    log: Vec<LogEntry>,
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

impl From<GamePhase> for AppGamePhase {
    fn from(value: GamePhase) -> AppGamePhase {
        match value {
            GamePhase::CardsRevealed => AppGamePhase::Revealed,
            GamePhase::Playing => AppGamePhase::Playing,
            GamePhase::Unknown => {
                warn!("Unknown GamePhase.");
                AppGamePhase::Unknown
            }
        }
    }
}

impl From<UserType> for AppUserType {
    fn from(value: UserType) -> AppUserType {
        match value {
            UserType::Spectator => AppUserType::Spectator,
            UserType::Participant => AppUserType::Player,
            UserType::Unknown => {
                warn!("Unknown UserType.");
                AppUserType::Unknown
            }
        }
    }
}

impl From<&User> for Player {
    fn from(value: &User) -> Player {
        let vote = if value.your_user && value.card_value.eq("") {
            Vote::Missing
        } else {
            parse_vote(value)
        };

        Player {
            vote,
            name: value.username.clone(),
            is_you: value.your_user,
            user_type: value.user_type.into(),
        }
    }
}

impl From<&Room> for AppRoom {
    fn from(value: &Room) -> AppRoom {
        let players = value.users.iter().map(|user| user.into()).collect();

        AppRoom {
            name: value.room_id.clone(),
            deck: value.deck.clone(),
            phase: value.game_phase.into(),
            players,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "requestType")]
enum UserRequest<'a> {
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

pub fn decode_room_snapshot(payload: &str) -> Result<RoomSnapshot, serde_json::Error> {
    let room: Room = serde_json::from_str(payload)?;
    let log = room
        .log
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let mut entry: ServerLogEntry = entry.try_into().ok()?;
            entry.server_index = index as u32;
            Some(entry)
        })
        .collect();

    Ok(RoomSnapshot {
        room: (&room).into(),
        log,
    })
}

fn encode_request(request: UserRequest<'_>) -> Result<String, serde_json::Error> {
    serde_json::to_string(&request)
}

pub fn encode_vote(card_value: &str) -> Result<String, serde_json::Error> {
    encode_request(UserRequest::PlayCard {
        card_value: Some(card_value),
    })
}

pub fn encode_retract_vote() -> Result<String, serde_json::Error> {
    encode_request(UserRequest::PlayCard { card_value: None })
}

pub fn encode_change_name(name: &str) -> Result<String, serde_json::Error> {
    encode_request(UserRequest::ChangeName { name })
}

pub fn encode_chat_message(message: &str) -> Result<String, serde_json::Error> {
    encode_request(UserRequest::ChatMessage { message })
}

pub fn encode_reveal_cards() -> Result<String, serde_json::Error> {
    encode_request(UserRequest::RevealCards)
}

pub fn encode_start_new_round() -> Result<String, serde_json::Error> {
    encode_request(UserRequest::StartNewRound)
}

pub fn build_room_url(
    endpoint: &str,
    room: &str,
    name: &str,
    role: ConnectionRole,
) -> Result<String, RoomUrlError> {
    if matches!(room, "." | "..") {
        return Err(RoomUrlError::InvalidRoom);
    }

    let mut url = Url::parse(endpoint)?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err(RoomUrlError::UnsupportedScheme);
    }
    if url.host().is_none() || url.cannot_be_a_base() {
        return Err(RoomUrlError::InvalidBaseUrl);
    }

    let authority = url
        .as_str()
        .split_once("://")
        .map(|(_, remainder)| remainder)
        .unwrap_or_default()
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.contains('@') {
        return Err(RoomUrlError::CredentialsNotAllowed);
    }
    if url.query().is_some() {
        return Err(RoomUrlError::QueryNotAllowed);
    }
    if url.fragment().is_some() {
        return Err(RoomUrlError::FragmentNotAllowed);
    }

    let trailing_separators = url
        .path()
        .chars()
        .rev()
        .take_while(|character| *character == '/')
        .count();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| RoomUrlError::InvalidBaseUrl)?;
        for _ in 0..trailing_separators {
            segments.pop();
        }
        segments.push("rooms").push(room);
    }
    url.query_pairs_mut().append_pair("user", name).append_pair(
        "userType",
        match role {
            ConnectionRole::Participant => "PARTICIPANT",
            ConnectionRole::Spectator => "SPECTATOR",
        },
    );

    Ok(url.into())
}

#[cfg(test)]
mod tests;
