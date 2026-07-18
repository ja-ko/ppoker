use std::time::Instant;

pub use ppoker_core::models::{
    GamePhase, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};

#[derive(Debug, PartialEq, Clone)]
pub struct LogEntry {
    pub timestamp: Instant,
    pub level: LogLevel,
    pub message: String,
    pub source: LogSource,
    pub server_index: Option<u32>,
}
