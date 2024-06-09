use std::cmp::Ordering;
use std::fmt::Formatter;
use std::time::Instant;

#[derive(Debug, PartialEq, Eq, Clone)]
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

#[derive(Debug, PartialEq, Eq, Clone)]
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

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum UserType {
    Player,
    Spectator,
}

#[derive(Debug, PartialEq, Eq, Clone)]
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

fn vote_rank(vote: &Vote) -> i32 {
    match vote {
        Vote::Missing => { 9999 }
        Vote::Hidden => { 9999 }
        Vote::Revealed(VoteData::Number(n)) => { *n as i32 }
        Vote::Revealed(VoteData::Special(_)) => { 999 }
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