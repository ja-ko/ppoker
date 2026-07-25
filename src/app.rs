use log::{debug, info};
use ppoker_core::client::{Client, ClientErrorCode, ClientResult, ClientUpdate, RoomTransition};
#[cfg(test)]
use ppoker_core::client::{Transport, TransportEvent};
#[cfg(test)]
use ppoker_core::protocol::RoomSnapshot;
#[cfg(test)]
use std::cell::RefCell;
#[cfg(test)]
use std::collections::VecDeque;
use std::error;
#[cfg(test)]
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::models::{
    GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};
use crate::notification::NotificationHandler;
use crate::web::client::connect;

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

struct LocalLogEntry {
    position: usize,
    entry: LogEntry,
}

#[cfg(test)]
#[derive(Default)]
struct InjectedTransportState {
    events: VecDeque<TransportEvent>,
    active: bool,
}

pub struct App {
    pub running: bool,
    client: Client,
    #[cfg(test)]
    client_updates: Option<Rc<RefCell<InjectedTransportState>>>,
    local_log: Vec<LocalLogEntry>,
    local_log_position: usize,
    round_started_at: Option<Instant>,
    history_durations: Vec<Option<Duration>>,

    pub config: Config,

    pub has_focus: bool,
    notify_vote_at: Option<Instant>,
    is_notified: bool,
    pub has_updates: bool,

    pub auto_reveal_at: Option<Instant>,

    pub notification_handler: Box<dyn NotificationHandler>,
    pub has_seen_changelog: bool,
}

impl App {
    pub fn new(config: Config) -> AppResult<Self> {
        let client = connect(&config)?;

        Ok(Self::from_client(config, client))
    }

    pub(crate) fn from_client(config: Config, client: Client) -> Self {
        let round_started_at = client.room().map(|_| Instant::now());
        let history_durations = vec![None; client.history().len()];

        Self {
            running: true,
            client,
            #[cfg(test)]
            client_updates: None,
            local_log: vec![],
            local_log_position: 0,
            round_started_at,
            history_durations,
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            auto_reveal_at: None,
            notification_handler: Box::new(crate::notification::create_notification_handler()),
            has_seen_changelog: false,
        }
    }

    pub fn tick(&mut self) -> AppResult<()> {
        self.check_notification();
        self.check_auto_reveal()?;
        Ok(())
    }

    fn check_notification(&mut self) {
        if let Some(notify_at) = &self.notify_vote_at {
            if *notify_at < Instant::now() && !self.is_notified {
                if self.has_focus {
                    info!("Skipping notification because user has application focused.")
                } else {
                    if self.config.disable_notifications {
                        info!("Skipping notification because user has them disabled.");
                    } else {
                        info!("Notifying user of missing vote.");
                        self.notification_handler.notify_with_bell(
                            "Planning Poker",
                            "Your vote is the last one missing.",
                        );
                    }
                }
                self.is_notified = true;
                self.notify_vote_at = None;
            }
        }
    }

    fn check_auto_reveal(&mut self) -> AppResult<()> {
        if let Some(auto_reveal_at) = &self.auto_reveal_at {
            if *auto_reveal_at < Instant::now() {
                self.reveal()?;
            }
        }
        Ok(())
    }

    pub fn cancel_auto_reveal(&mut self) {
        self.auto_reveal_at = None;
    }

    fn is_vote_last_missing(room: &Room) -> bool {
        let missing_players = room
            .players
            .iter()
            .filter(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing)
            .collect::<Vec<&Player>>();
        room.players.len() > 1
            && missing_players.len() == 1
            && missing_players[0].is_you
            && room.phase == GamePhase::Playing
    }

    fn confirms_last_missing_vote(previous: &Room, room: &Room) -> bool {
        Self::is_vote_last_missing(previous)
            && room.phase == GamePhase::Playing
            && room.players.iter().any(|player| {
                player.is_you
                    && player.user_type != UserType::Spectator
                    && matches!(player.vote, Vote::Revealed(_))
            })
            && !room.players.iter().any(|player| {
                player.user_type != UserType::Spectator && player.vote == Vote::Missing
            })
    }

    fn merge_round_timing(
        update: &RoomTransition,
        round_started_at: &mut Option<Instant>,
        history_durations: &mut Vec<Option<Duration>>,
    ) {
        let now = Instant::now();
        let phase_changed = update
            .previous_room
            .as_ref()
            .is_some_and(|old| old.phase != update.room.phase);

        while history_durations.len() < update.history_len {
            let duration = if phase_changed && update.room.phase == GamePhase::Revealed {
                round_started_at
                    .take()
                    .map(|started_at| now.saturating_duration_since(started_at))
            } else {
                None
            };
            history_durations.push(duration);
        }

        if phase_changed && update.room.phase == GamePhase::Playing {
            *round_started_at = Some(now);
        }
    }

    fn handle_session_update(&mut self, update: ClientUpdate) {
        let ClientUpdate::Room(update) = update;
        Self::merge_round_timing(
            &update,
            &mut self.round_started_at,
            &mut self.history_durations,
        );

        let room = &update.room;
        if let Some(old) = update.previous_room.as_ref() {
            if old.phase != room.phase {
                if room.phase == GamePhase::Playing {
                    self.is_notified = false;
                    self.notify_vote_at = None;
                }
                self.has_updates = true;
            }
            if !self.config.disable_auto_reveal && Self::confirms_last_missing_vote(old, room) {
                debug!("Starting auto-reveal timer.");
                self.auto_reveal_at = Some(Instant::now() + Duration::from_secs(3));
            }
        }

        if Self::is_vote_last_missing(room) {
            if !self.is_notified && self.notify_vote_at.is_none() {
                Self::push_log_message(
                    &mut self.local_log,
                    self.local_log_position,
                    self.client.now(),
                    LogLevel::Info,
                    "Your vote is the last one missing.".to_string(),
                );
                self.notify_vote_at = Some(Instant::now() + Duration::from_secs(8));
                self.has_updates = true;
            }
        } else {
            self.notify_vote_at = None;
        }

        if self.auto_reveal_at.is_some()
            && (room.phase != GamePhase::Playing
                || room
                    .players
                    .iter()
                    .any(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing))
        {
            debug!("Auto-reveal cancelled because of invalid state");
            self.auto_reveal_at = None;
        }
    }

    #[cfg(test)]
    pub fn merge_update(&mut self, update: Room) {
        self.merge_snapshot(RoomSnapshot {
            room: update,
            log: vec![],
        });
    }

    #[cfg(test)]
    fn merge_snapshot(&mut self, update: RoomSnapshot) {
        self.queue_test_snapshot(update);
        self.update().expect("test client update should succeed");
    }

    #[cfg(test)]
    fn queue_test_snapshot(&self, update: RoomSnapshot) {
        self.client_updates
            .as_ref()
            .expect("test Apps have an injectable client transport")
            .borrow_mut()
            .events
            .push_back(test_snapshot_event(update));
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let data = data.trim();
        let result = if data == "-" {
            self.client.retract_vote()
        } else {
            let card = self
                .room()
                .deck
                .iter()
                .find(|card| card.as_str() == data)
                .or_else(|| {
                    self.room()
                        .deck
                        .iter()
                        .find(|card| card.eq_ignore_ascii_case(data))
                })
                .cloned()
                .unwrap_or_else(|| data.to_string());
            self.client.vote(&card)
        };
        self.handle_command_result(result)
    }

    pub fn rename(&mut self, data: String) -> AppResult<()> {
        self.client.rename(data)?;
        Ok(())
    }

    pub fn reveal(&mut self) -> AppResult<()> {
        self.client.ensure_ready()?;
        self.cancel_auto_reveal();
        self.client.reveal()?;
        Ok(())
    }

    pub fn chat(&mut self, message: String) -> AppResult<()> {
        self.client.chat(message)?;
        Ok(())
    }

    pub fn restart(&mut self) -> AppResult<()> {
        let result = self.client.restart();
        self.handle_command_result(result)
    }

    pub fn update(&mut self) -> AppResult<()> {
        self.local_log_position = self.client.log().len();
        let outcome = self.client.poll()?;
        for update in outcome.updates {
            debug!("room update: {:?}", update);
            self.handle_session_update(update);
        }
        self.local_log_position = self.client.log().len();

        Ok(())
    }

    pub fn room(&self) -> &Room {
        self.client
            .room()
            .expect("native App is created after its initial room snapshot")
    }

    #[cfg(test)]
    pub fn set_room_for_test(&mut self, room: Room) {
        self.queue_test_snapshot(RoomSnapshot { room, log: vec![] });
        self.client
            .poll()
            .expect("test client update should succeed");
    }

    pub fn own_vote(&self) -> &Option<VoteData> {
        self.client.own_vote()
    }

    pub fn name(&self) -> &str {
        self.client.name()
    }

    pub fn history(&self) -> &[HistoryEntry] {
        self.client.history()
    }

    pub fn round_number(&self) -> u32 {
        self.client.round_number()
    }

    pub fn round_elapsed(&self) -> Duration {
        self.round_started_at
            .map(|started_at| started_at.elapsed())
            .unwrap_or_default()
    }

    pub fn history_duration(&self, index: usize) -> Duration {
        self.history_durations
            .get(index)
            .copied()
            .flatten()
            .unwrap_or_default()
    }

    pub fn activity_log(&self) -> Vec<&LogEntry> {
        let log = self.client.log();
        let mut result = Vec::with_capacity(log.len() + self.local_log.len());
        for position in 0..=log.len() {
            result.extend(
                self.local_log
                    .iter()
                    .filter(|entry| entry.position == position)
                    .map(|entry| &entry.entry),
            );
            if let Some(entry) = log.get(position) {
                result.push(entry);
            }
        }
        result
    }

    fn push_log_message(
        local_log: &mut Vec<LocalLogEntry>,
        position: usize,
        timestamp: Duration,
        level: LogLevel,
        message: String,
    ) {
        local_log.push(LocalLogEntry {
            position,
            entry: LogEntry {
                timestamp,
                level,
                message,
                source: LogSource::Client,
                server_index: None,
            },
        })
    }

    fn handle_command_result(&mut self, result: ClientResult<()>) -> AppResult<()> {
        match result {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.code,
                    ClientErrorCode::InvalidCard | ClientErrorCode::InvalidState
                ) =>
            {
                Self::push_log_message(
                    &mut self.local_log,
                    self.client.log().len(),
                    self.client.now(),
                    LogLevel::Error,
                    error.message,
                );
                Ok(())
            }
            Err(error) => Err(Box::new(error)),
        }
    }

    pub fn average_votes(&self) -> f32 {
        self.client.average_votes().unwrap_or(f32::NAN)
    }
}

#[cfg(test)]
pub(crate) fn encode_test_snapshot(snapshot: RoomSnapshot) -> String {
    let RoomSnapshot { room, log } = snapshot;
    let phase = match room.phase {
        GamePhase::Playing => "PLAYING",
        GamePhase::Revealed => "CARDS_REVEALED",
        GamePhase::Unknown => "FUTURE_PHASE",
    };
    let users = room
        .players
        .into_iter()
        .map(|player| {
            let user_type = match player.user_type {
                UserType::Player => "PARTICIPANT",
                UserType::Spectator => "SPECTATOR",
                UserType::Unknown => "FUTURE_TYPE",
            };
            let card_value = match player.vote {
                Vote::Missing => String::new(),
                Vote::Hidden => "✅".to_string(),
                Vote::Revealed(vote) => vote.to_string(),
            };
            serde_json::json!({
                "username": player.name,
                "userType": user_type,
                "yourUser": player.is_you,
                "cardValue": card_value,
            })
        })
        .collect::<Vec<_>>();
    let logs = log
        .iter()
        .map(|entry| {
            let level = match entry.level {
                LogLevel::Chat => "CHAT",
                LogLevel::Info => "INFO",
                LogLevel::Error => "ERROR",
            };
            serde_json::json!({ "level": level, "message": entry.message })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "roomId": room.name,
        "deck": room.deck,
        "gamePhase": phase,
        "users": users,
        "average": "0",
        "log": logs,
    })
    .to_string()
}

#[cfg(test)]
pub(crate) fn test_snapshot_event(snapshot: RoomSnapshot) -> TransportEvent {
    TransportEvent::Text(encode_test_snapshot(snapshot))
}

#[cfg(test)]
pub(crate) fn test_room_event(room: Room) -> TransportEvent {
    test_snapshot_event(RoomSnapshot { room, log: vec![] })
}

#[cfg(test)]
pub mod tests;
