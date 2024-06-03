use std::fmt::Formatter;
use std::time::Instant;

#[derive(Debug, PartialEq, Clone)]
pub enum VoteData {
    Number(u8),
    Special(String),
}

impl std::fmt::Display for VoteData {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            VoteData::Number(n) => { f.write_fmt(format_args!("{}", n)) }
            VoteData::Special(c) => { f.write_fmt(format_args!("{}", c)) }
        }
    }
}

#[derive(Debug, PartialEq, Clone)]
pub enum Vote {
    Missing,
    Hidden,
    Revealed(VoteData),
}

impl std::fmt::Display for Vote {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Vote::Missing => { f.write_str("Missing") }
            Vote::Hidden => { f.write_str("Hidden") }
            Vote::Revealed(v) => { f.write_fmt(format_args!("{}", v)) }
        }
    }
}

#[derive(Debug, PartialEq, Clone)]
pub enum UserType {
    Player,
    Spectator,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Player {
    pub name: String,
    pub vote: Vote,
    pub is_you: bool,
    pub user_type: UserType,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GamePhase {
    Playing,
    Revealed,
}

impl std::fmt::Display for GamePhase {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            GamePhase::Playing => { write!(f, "Playing") }
            GamePhase::Revealed => { write!(f, "Waiting") }
        }
    }
}

#[derive(Debug, PartialEq, Copy, Clone)]
pub enum LogLevel {
    Chat,
    Info,
    Error,
}

#[derive(Debug, PartialEq, Copy, Clone)]
pub enum LogSource {
    Server,
    Client,
}


#[derive(Debug, PartialEq, Clone)]
pub struct LogEntry {
    pub timestamp: Instant,
    pub level: LogLevel,
    pub message: String,
    pub source: LogSource,
    pub server_index: Option<u32>,
}

#[derive(Debug, PartialEq)]
pub struct Room {
    pub name: String,
    pub deck: Vec<String>,
    pub phase: GamePhase,
    pub players: Vec<Player>,
}