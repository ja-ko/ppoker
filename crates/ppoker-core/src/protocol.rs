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

impl Into<AppGamePhase> for GamePhase {
    fn into(self) -> AppGamePhase {
        match self {
            GamePhase::CardsRevealed => AppGamePhase::Revealed,
            GamePhase::Playing => AppGamePhase::Playing,
            GamePhase::Unknown => {
                warn!("Unknown GamePhase.");
                AppGamePhase::Unknown
            }
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
            }
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
mod tests {
    use serde_json::{json, Value};

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

    fn payload_with_users(users: Value) -> String {
        json!({
            "roomId": "room / 東京",
            "deck": ["1", "8", "?", "☕"],
            "gamePhase": "PLAYING",
            "users": users,
            "average": "0",
            "log": []
        })
        .to_string()
    }

    #[test]
    fn wire_room_json_structure_is_preserved() {
        let room = room_fixture();
        let expected = json!({
            "roomId": "roomid",
            "deck": ["1", "2", "3", "5"],
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
            "log": [{ "level": "CHAT", "message": "Hello World" }]
        });

        assert_eq!(serde_json::to_value(room).unwrap(), expected);
    }

    #[test]
    fn full_room_payload_decodes_as_authoritative_snapshot_in_wire_order() {
        let payload = json!({
            "roomId": "planning-room",
            "deck": ["1", "3", "?", "☕"],
            "gamePhase": "CARDS_REVEALED",
            "users": [
                {
                    "username": "Alice",
                    "userType": "PARTICIPANT",
                    "yourUser": true,
                    "cardValue": "13"
                },
                {
                    "username": "Bøb",
                    "userType": "PARTICIPANT",
                    "yourUser": false,
                    "cardValue": "☕"
                },
                {
                    "username": "Observer",
                    "userType": "SPECTATOR",
                    "yourUser": false,
                    "cardValue": "8"
                }
            ],
            "average": "13",
            "log": [
                { "level": "CHAT", "message": "héllo 世界" },
                { "level": "INFO", "message": "revealed" },
                { "level": "ERROR", "message": "problem" }
            ]
        })
        .to_string();

        let snapshot = decode_room_snapshot(&payload).unwrap();

        assert_eq!(snapshot.room.name, "planning-room");
        assert_eq!(snapshot.room.deck, ["1", "3", "?", "☕"]);
        assert_eq!(snapshot.room.phase, AppGamePhase::Revealed);
        assert_eq!(
            snapshot
                .room
                .players
                .iter()
                .map(|player| player.name.as_str())
                .collect::<Vec<_>>(),
            ["Alice", "Bøb", "Observer"]
        );
        assert_eq!(
            snapshot.room.players[0].vote,
            Vote::Revealed(VoteData::Number(13))
        );
        assert_eq!(
            snapshot.room.players[1].vote,
            Vote::Revealed(VoteData::Special("☕".to_string()))
        );
        assert_eq!(snapshot.room.players[2].vote, Vote::Missing);
        assert_eq!(
            snapshot
                .log
                .iter()
                .map(|entry| (entry.server_index, entry.level, entry.message.as_str()))
                .collect::<Vec<_>>(),
            [
                (0, AppLogLevel::Chat, "héllo 世界"),
                (1, AppLogLevel::Info, "revealed"),
                (2, AppLogLevel::Error, "problem"),
            ]
        );
    }

    #[test]
    fn vote_sentinels_and_unicode_special_votes_are_normalized() {
        let payload = payload_with_users(json!([
            {
                "username": "hidden",
                "userType": "PARTICIPANT",
                "yourUser": false,
                "cardValue": "✅"
            },
            {
                "username": "missing-cross",
                "userType": "PARTICIPANT",
                "yourUser": false,
                "cardValue": "❌"
            },
            {
                "username": "missing-empty",
                "userType": "PARTICIPANT",
                "yourUser": true,
                "cardValue": ""
            },
            {
                "username": "number",
                "userType": "PARTICIPANT",
                "yourUser": false,
                "cardValue": "8"
            },
            {
                "username": "special",
                "userType": "PARTICIPANT",
                "yourUser": false,
                "cardValue": "☕"
            },
            {
                "username": "spectator-hidden",
                "userType": "SPECTATOR",
                "yourUser": false,
                "cardValue": "✅"
            }
        ]));

        let votes = decode_room_snapshot(&payload)
            .unwrap()
            .room
            .players
            .into_iter()
            .map(|player| player.vote)
            .collect::<Vec<_>>();

        assert_eq!(
            votes,
            [
                Vote::Hidden,
                Vote::Missing,
                Vote::Missing,
                Vote::Revealed(VoteData::Number(8)),
                Vote::Revealed(VoteData::Special("☕".to_string())),
                Vote::Hidden,
            ]
        );
    }

    #[test]
    fn unknown_wire_enums_never_panic_and_unsafe_logs_are_skipped() {
        let payload = json!({
            "roomId": "unknown-test",
            "deck": ["1"],
            "gamePhase": "FUTURE_PHASE",
            "users": [{
                "username": "Future user",
                "userType": "FUTURE_ROLE",
                "yourUser": true,
                "cardValue": "5"
            }],
            "average": "5",
            "log": [
                { "level": "INFO", "message": "before" },
                { "level": "FUTURE_LEVEL", "message": "skip" },
                { "level": "CHAT", "message": "after" }
            ]
        })
        .to_string();

        let snapshot = decode_room_snapshot(&payload).unwrap();

        assert_eq!(snapshot.room.phase, AppGamePhase::Unknown);
        assert_eq!(snapshot.room.players[0].user_type, AppUserType::Unknown);
        assert_eq!(
            snapshot.room.players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        );
        assert_eq!(
            snapshot
                .log
                .iter()
                .map(|entry| (entry.server_index, entry.message.as_str()))
                .collect::<Vec<_>>(),
            [(0, "before"), (2, "after")]
        );
    }

    #[test]
    fn malformed_room_payloads_are_rejected() {
        assert!(decode_room_snapshot("not json").is_err());
        assert!(decode_room_snapshot(r#"{"roomId":"missing-fields"}"#).is_err());
    }

    #[test]
    fn every_command_keeps_its_exact_json_contract() {
        assert_eq!(
            encode_vote("13").unwrap(),
            r#"{"requestType":"PlayCard","cardValue":"13"}"#
        );
        assert_eq!(
            encode_vote("☕/世界").unwrap(),
            r#"{"requestType":"PlayCard","cardValue":"☕/世界"}"#
        );
        assert_eq!(
            encode_retract_vote().unwrap(),
            r#"{"requestType":"PlayCard","cardValue":null}"#
        );
        assert_eq!(
            encode_change_name("Ålice 東京").unwrap(),
            r#"{"requestType":"ChangeName","name":"Ålice 東京"}"#
        );
        assert_eq!(
            encode_chat_message("hello \"world\"\n世界").unwrap(),
            r#"{"requestType":"ChatMessage","message":"hello \"world\"\n世界"}"#
        );
        assert_eq!(
            encode_reveal_cards().unwrap(),
            r#"{"requestType":"RevealCards"}"#
        );
        assert_eq!(
            encode_start_new_round().unwrap(),
            r#"{"requestType":"StartNewRound"}"#
        );
    }

    #[test]
    fn room_urls_preserve_root_and_nested_base_paths_without_trailing_separators() {
        assert_eq!(
            build_room_url(
                "wss://example.test",
                "planning",
                "Alice",
                ConnectionRole::Participant
            )
            .unwrap(),
            "wss://example.test/rooms/planning?user=Alice&userType=PARTICIPANT"
        );
        assert_eq!(
            build_room_url(
                "ws://example.test/",
                "planning",
                "Alice",
                ConnectionRole::Participant
            )
            .unwrap(),
            "ws://example.test/rooms/planning?user=Alice&userType=PARTICIPANT"
        );
        assert_eq!(
            build_room_url(
                "wss://example.test/base/path///",
                "planning",
                "Observer",
                ConnectionRole::Spectator
            )
            .unwrap(),
            "wss://example.test/base/path/rooms/planning?user=Observer&userType=SPECTATOR"
        );
    }

    #[test]
    fn room_urls_encode_hostile_and_unicode_values_once() {
        let room = "% /?#&= %2F 東京☕";
        let name = "Ålice % /?#&= %2F 東京☕";
        let url = build_room_url(
            "wss://example.test/nested/base/",
            room,
            name,
            ConnectionRole::Spectator,
        )
        .unwrap();

        assert_eq!(
            url,
            "wss://example.test/nested/base/rooms/%25%20%2F%3F%23&=%20%252F%20%E6%9D%B1%E4%BA%AC%E2%98%95?user=%C3%85lice+%25+%2F%3F%23%26%3D+%252F+%E6%9D%B1%E4%BA%AC%E2%98%95&userType=SPECTATOR"
        );
    }

    #[test]
    fn room_urls_reject_exact_dot_names_without_rejecting_other_dots() {
        for room in [".", ".."] {
            let error = build_room_url("not a URL", room, "Alice", ConnectionRole::Participant)
                .unwrap_err();

            assert_eq!(error, RoomUrlError::InvalidRoom);
            assert_eq!(error.field(), "room");
            assert_eq!(error.to_string(), "Room must not be `.` or `..`.");
        }

        for room in [".planning", "planning.", "..."] {
            let url = build_room_url(
                "wss://example.test/nested/base/",
                room,
                "Alice",
                ConnectionRole::Participant,
            )
            .unwrap();

            assert!(url.contains(&format!("/rooms/{room}?user=Alice&")));
        }
    }

    #[test]
    fn room_urls_reject_non_base_endpoint_components() {
        assert!(matches!(
            build_room_url("not a URL", "room", "user", ConnectionRole::Participant),
            Err(RoomUrlError::InvalidUrl(_))
        ));
        assert_eq!(
            build_room_url(
                "https://example.test",
                "room",
                "user",
                ConnectionRole::Participant
            ),
            Err(RoomUrlError::UnsupportedScheme)
        );
        assert_eq!(
            build_room_url(
                "wss://user:password@example.test/base",
                "room",
                "user",
                ConnectionRole::Participant
            ),
            Err(RoomUrlError::CredentialsNotAllowed)
        );
        assert_eq!(
            build_room_url(
                "wss://example.test/base?existing=value",
                "room",
                "user",
                ConnectionRole::Participant
            ),
            Err(RoomUrlError::QueryNotAllowed)
        );
        assert_eq!(
            build_room_url(
                "wss://example.test/base#fragment",
                "room",
                "user",
                ConnectionRole::Participant
            ),
            Err(RoomUrlError::FragmentNotAllowed)
        );
    }

    #[test]
    fn room_url_errors_have_stable_messages_and_sources() {
        let parse_error =
            build_room_url("not a URL", "room", "user", ConnectionRole::Participant).unwrap_err();
        assert!(parse_error
            .to_string()
            .starts_with("invalid WebSocket URL:"));
        assert_eq!(parse_error.field(), "endpoint");
        assert!(parse_error.source().is_some());

        for error in [
            RoomUrlError::InvalidRoom,
            RoomUrlError::UnsupportedScheme,
            RoomUrlError::CredentialsNotAllowed,
            RoomUrlError::QueryNotAllowed,
            RoomUrlError::FragmentNotAllowed,
            RoomUrlError::InvalidBaseUrl,
        ] {
            assert!(!error.to_string().is_empty());
            assert!(error.source().is_none());
        }
    }
}
