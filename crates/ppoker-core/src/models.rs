use std::cmp::Ordering;
use std::fmt::Formatter;
use std::time::Duration;

use serde::Serialize;

pub(crate) const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum VoteData {
    Number(u8),
    Special(String),
}

impl std::fmt::Display for VoteData {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            VoteData::Number(n) => f.write_fmt(format_args!("{}", n)),
            VoteData::Special(c) => f.write_fmt(format_args!("{}", c)),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(tag = "state", content = "value", rename_all = "camelCase")]
pub enum Vote {
    Missing,
    Hidden,
    Revealed(VoteData),
}

impl std::fmt::Display for Vote {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Vote::Missing => f.write_str("Missing"),
            Vote::Hidden => f.write_str("Hidden"),
            Vote::Revealed(v) => f.write_fmt(format_args!("{}", v)),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum UserType {
    Player,
    Spectator,
    Unknown,
}

#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub name: String,
    pub vote: Vote,
    pub is_you: bool,
    pub user_type: UserType,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum GamePhase {
    Playing,
    Revealed,
    Unknown,
}

impl std::fmt::Display for GamePhase {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            GamePhase::Playing => {
                write!(f, "Playing")
            }
            GamePhase::Revealed => {
                write!(f, "Waiting")
            }
            GamePhase::Unknown => {
                write!(f, "Unknown")
            }
        }
    }
}

#[derive(Debug, PartialEq, Copy, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Chat,
    Info,
    Error,
}

#[derive(Debug, PartialEq, Copy, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum LogSource {
    Server,
    Client,
}

#[derive(Debug, PartialEq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub name: String,
    pub deck: Vec<String>,
    pub phase: GamePhase,
    pub players: Vec<Player>,
}

#[derive(Debug, PartialEq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[cfg_attr(feature = "typescript", tsify(missing_as_null))]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    #[serde(rename = "timestampMs", serialize_with = "serialize_duration_ms")]
    #[cfg_attr(feature = "typescript", tsify(type = "number"))]
    pub timestamp: Duration,
    pub level: LogLevel,
    pub message: String,
    pub source: LogSource,
    pub server_index: Option<u32>,
}

#[derive(Debug, PartialEq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[cfg_attr(feature = "typescript", tsify(missing_as_null))]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub round_number: u32,
    pub average: Option<f32>,
    pub votes: Vec<Player>,
    pub deck: Vec<String>,
    pub own_vote: Option<VoteData>,
}

fn serialize_duration_ms<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_f64(duration_ms(*duration).map_err(serde::ser::Error::custom)?)
}

pub(crate) fn duration_ms(duration: Duration) -> Result<f64, &'static str> {
    let milliseconds = duration.as_millis();
    if milliseconds > MAX_SAFE_INTEGER {
        return Err("duration exceeds the JavaScript safe integer range");
    }
    Ok(milliseconds as f64)
}

fn vote_rank(vote: &Vote) -> i32 {
    match vote {
        Vote::Missing => 9999,
        Vote::Hidden => 9999,
        Vote::Revealed(VoteData::Number(n)) => *n as i32,
        Vote::Revealed(VoteData::Special(_)) => 999,
    }
}

impl PartialOrd<Self> for Vote {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        return vote_rank(&self).partial_cmp(&vote_rank(&other));
    }
}

impl Ord for Vote {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).expect("Unable to compare votes")
    }
}

impl PartialOrd<Self> for Player {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        let vote_order = self.vote.cmp(&other.vote);
        if vote_order == Ordering::Equal {
            Some(self.name.cmp(&other.name))
        } else {
            Some(vote_order)
        }
    }
}

impl Ord for Player {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).expect("Unable to compare players")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(name: &str, vote: Vote) -> Player {
        Player {
            name: name.to_string(),
            vote,
            is_you: false,
            user_type: UserType::Player,
        }
    }

    #[test]
    fn test_player_ordering() {
        let players = vec![
            player("Alice", Vote::Revealed(VoteData::Number(3))),
            player("Bob", Vote::Hidden),
            player("Charlie", Vote::Revealed(VoteData::Number(1))),
            player("David", Vote::Missing),
            player("Eve", Vote::Revealed(VoteData::Special("?".to_string()))),
        ];

        let mut sorted = players.clone();
        sorted.sort();

        assert_eq!(
            sorted
                .iter()
                .map(|player| player.name.as_str())
                .collect::<Vec<_>>(),
            ["Charlie", "Alice", "Eve", "Bob", "David"]
        );
        assert_eq!(Vote::Hidden.to_string(), "Hidden");
        assert_eq!(GamePhase::Unknown.to_string(), "Unknown");
        assert_eq!(sorted[0].cmp(&sorted[1]), Ordering::Less);
    }

    #[test]
    fn web_serialization_uses_core_names_safe_milliseconds_and_nulls() {
        let entry = HistoryEntry {
            round_number: 2,
            average: None,
            votes: vec![Player {
                name: "Alice".to_string(),
                vote: Vote::Revealed(VoteData::Number(5)),
                is_you: true,
                user_type: UserType::Player,
            }],
            deck: vec!["5".to_string()],
            own_vote: None,
        };

        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            serde_json::json!({
                "roundNumber": 2,
                "average": null,
                "votes": [{
                    "name": "Alice",
                    "vote": { "state": "revealed", "value": { "kind": "number", "value": 5 } },
                    "isYou": true,
                    "userType": "player"
                }],
                "deck": ["5"],
                "ownVote": null
            })
        );

        let unsafe_entry = LogEntry {
            timestamp: Duration::from_millis((MAX_SAFE_INTEGER + 1) as u64),
            level: LogLevel::Info,
            message: String::new(),
            source: LogSource::Client,
            server_index: None,
        };
        assert!(serde_json::to_value(unsafe_entry).is_err());
    }
}
