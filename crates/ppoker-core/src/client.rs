use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::rc::Rc;
use std::time::Duration;

use log::warn;
use serde::Serialize;

use crate::models::{
    duration_ms, GamePhase, HistoryEntry, LogEntry, LogSource, Room, Vote, VoteData,
};
use crate::protocol::{
    decode_room_snapshot, encode_change_name, encode_chat_message, encode_retract_vote,
    encode_reveal_cards, encode_start_new_round, encode_vote, RoomSnapshot,
};

pub trait Clock {
    fn now(&self) -> Duration;
}

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
pub enum ClientErrorCode {
    NotReady,
    InvalidCard,
    InvalidState,
    Closed,
    Transport,
    Protocol,
}

#[derive(Debug, PartialEq, Eq, Clone, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub struct ClientError {
    pub code: ClientErrorCode,
    pub message: String,
}

impl ClientError {
    pub fn not_ready(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::NotReady,
            message: message.into(),
        }
    }

    pub fn closed(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::Closed,
            message: message.into(),
        }
    }

    fn invalid_card(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::InvalidCard,
            message: message.into(),
        }
    }

    fn invalid_state(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::InvalidState,
            message: message.into(),
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::Transport,
            message: message.into(),
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: ClientErrorCode::Protocol,
            message: message.into(),
        }
    }
}

impl Display for ClientError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ClientError {}

pub type ClientResult<T> = Result<T, ClientError>;

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "typescript", derive(tsify::Tsify))]
#[cfg_attr(feature = "typescript", tsify(missing_as_null))]
#[serde(rename_all = "camelCase")]
pub struct ClientSnapshot {
    pub revision: u32,
    pub status: ConnectionStatus,
    pub terminal_error: Option<ClientError>,
    pub room: Option<Room>,
    pub local_name: String,
    pub local_vote: Option<VoteData>,
    pub log: Vec<LogEntry>,
    pub round_number: u32,
    pub history: Vec<HistoryEntry>,
    pub average: Option<f32>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TransportEvent {
    Opened,
    Text(String),
    Binary { length: usize },
    Closed,
    Error(String),
}

pub trait Transport {
    fn poll_event(&mut self) -> Option<TransportEvent>;
    fn send_text(&mut self, message: String) -> Result<(), String>;
    fn close(&mut self);
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomTransition {
    pub previous_room: Option<Room>,
    pub room: Room,
    pub history_len: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClientUpdate {
    Room(RoomTransition),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PollOutcome {
    pub changed: bool,
    pub updates: Vec<ClientUpdate>,
}

#[derive(Debug, PartialEq, Eq)]
struct PublicState {
    status: ConnectionStatus,
    terminal_error: Option<ClientError>,
}

enum TransportEventEffect {
    NoClientUpdate,
    ClientUpdate {
        snapshot_changed: bool,
        update: ClientUpdate,
    },
}

pub struct Client {
    transport: Option<Box<dyn Transport>>,
    status: ConnectionStatus,
    terminal_error: Option<ClientError>,
    pending_error: Option<ClientError>,
    vote: Option<VoteData>,
    name: String,
    room: Option<Room>,
    log: Vec<LogEntry>,
    seen_server_log_indexes: HashSet<u32>,
    round_number: u32,
    history: Vec<HistoryEntry>,
    revision: u32,
    clock: Rc<dyn Clock>,
}

impl Client {
    pub fn new(name: String, clock: Rc<dyn Clock>) -> Self {
        Self {
            transport: None,
            status: ConnectionStatus::Disconnected,
            terminal_error: None,
            pending_error: None,
            vote: None,
            name,
            room: None,
            log: vec![],
            seen_server_log_indexes: HashSet::new(),
            round_number: 0,
            history: vec![],
            revision: 0,
            clock,
        }
    }

    pub fn connect(&mut self, mut transport: Box<dyn Transport>) -> ClientResult<bool> {
        let before = self.public_state();
        let result = match self.status {
            ConnectionStatus::Disconnected => {
                self.transport = Some(transport);
                self.status = ConnectionStatus::Connecting;
                Ok(())
            }
            ConnectionStatus::Connecting | ConnectionStatus::Open => {
                transport.close();
                Ok(())
            }
            ConnectionStatus::Closed => {
                transport.close();
                Err(ClientError::closed("Client is closed."))
            }
        };
        let changed = self.commit_operation(before, false);
        result.map(|_| changed)
    }

    pub fn fail_transport(&mut self, message: impl Into<String>) -> ClientError {
        let before = self.public_state();
        let error = ClientError::transport(message);
        self.finish(Some(error.clone()));
        self.commit_operation(before, false);
        error
    }

    pub fn own_vote(&self) -> &Option<VoteData> {
        &self.vote
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn room(&self) -> Option<&Room> {
        self.room.as_ref()
    }

    pub fn log(&self) -> &[LogEntry] {
        &self.log
    }

    pub fn round_number(&self) -> u32 {
        self.round_number
    }

    pub fn history(&self) -> &[HistoryEntry] {
        &self.history
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    pub fn snapshot(&self) -> ClientResult<ClientSnapshot> {
        for entry in &self.log {
            snapshot_duration_ms(entry.timestamp)?;
        }
        for entry in &self.history {
            snapshot_average(entry.average)?;
        }

        Ok(ClientSnapshot {
            revision: self.revision,
            status: self.status(),
            terminal_error: self.terminal_error().cloned(),
            room: self.room.clone(),
            local_name: self.name.clone(),
            local_vote: self.vote.clone(),
            log: self.log.clone(),
            round_number: self.round_number,
            history: self.history.clone(),
            average: snapshot_average(self.average_votes())?,
        })
    }

    pub fn status(&self) -> ConnectionStatus {
        self.status
    }

    pub fn terminal_error(&self) -> Option<&ClientError> {
        self.terminal_error.as_ref()
    }

    pub fn ensure_ready(&self) -> ClientResult<()> {
        match self.status {
            ConnectionStatus::Open => Ok(()),
            ConnectionStatus::Closed => Err(ClientError::closed("Client is closed.")),
            ConnectionStatus::Disconnected | ConnectionStatus::Connecting => {
                Err(ClientError::not_ready("WebSocket connection is not open."))
            }
        }
    }

    pub fn now(&self) -> Duration {
        self.clock.now()
    }

    #[cfg(test)]
    fn apply_room_snapshot(&mut self, snapshot: RoomSnapshot) -> Option<Room> {
        let (transition, changed) = self.merge_room_snapshot(snapshot);
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        transition.previous_room
    }

    pub fn poll(&mut self) -> ClientResult<PollOutcome> {
        self.poll_inner(false)
    }

    pub fn poll_next_room(&mut self) -> ClientResult<PollOutcome> {
        self.poll_inner(true)
    }

    pub fn handle_transport_event(&mut self, event: TransportEvent) -> ClientResult<PollOutcome> {
        if self.status == ConnectionStatus::Closed {
            return Err(ClientError::closed("Client is closed."));
        }

        let before = self.public_state();
        let (snapshot_changed, updates) = match self.apply_transport_event(event) {
            Ok(TransportEventEffect::NoClientUpdate) => (false, vec![]),
            Ok(TransportEventEffect::ClientUpdate {
                snapshot_changed,
                update,
            }) => (snapshot_changed, vec![update]),
            Err(error) => {
                self.commit_operation(before, false);
                return Err(error);
            }
        };
        let changed = self.commit_operation(before, snapshot_changed);
        Ok(PollOutcome { changed, updates })
    }

    fn poll_inner(&mut self, stop_after_room: bool) -> ClientResult<PollOutcome> {
        let before = self.public_state();
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }

        let mut snapshot_changed = false;
        let mut updates = vec![];
        loop {
            let event = match self.transport.as_mut() {
                Some(transport) => transport.poll_event(),
                None => None,
            };
            let Some(event) = event else {
                break;
            };
            match self.apply_transport_event(event) {
                Ok(TransportEventEffect::NoClientUpdate) => {}
                Ok(TransportEventEffect::ClientUpdate {
                    snapshot_changed: event_changed,
                    update,
                }) => {
                    snapshot_changed |= event_changed;
                    updates.push(update);
                    if stop_after_room {
                        break;
                    }
                }
                Err(error) => {
                    if updates.is_empty() {
                        self.commit_operation(before, snapshot_changed);
                        return Err(error);
                    }
                    self.pending_error = Some(error);
                    break;
                }
            }
        }

        let changed = self.commit_operation(before, snapshot_changed);
        Ok(PollOutcome { changed, updates })
    }

    fn apply_transport_event(
        &mut self,
        event: TransportEvent,
    ) -> ClientResult<TransportEventEffect> {
        match event {
            TransportEvent::Opened => {
                self.status = ConnectionStatus::Open;
                Ok(TransportEventEffect::NoClientUpdate)
            }
            TransportEvent::Text(text) => match decode_room_snapshot(&text) {
                Ok(snapshot) => {
                    let (transition, changed) = self.merge_room_snapshot(snapshot);
                    Ok(TransportEventEffect::ClientUpdate {
                        snapshot_changed: changed,
                        update: ClientUpdate::Room(transition),
                    })
                }
                Err(error) => {
                    let error = ClientError::protocol(error.to_string());
                    self.finish(Some(error.clone()));
                    Err(error)
                }
            },
            TransportEvent::Binary { length } => {
                warn!(
                    "Ignoring unsupported binary WebSocket message ({} bytes).",
                    length
                );
                Ok(TransportEventEffect::NoClientUpdate)
            }
            TransportEvent::Closed => {
                let error = ClientError::closed("Server closed connection.");
                self.finish(None);
                Err(error)
            }
            TransportEvent::Error(message) => {
                let error = ClientError::transport(message);
                self.finish(Some(error.clone()));
                Err(error)
            }
        }
    }

    fn merge_room_snapshot(&mut self, snapshot: RoomSnapshot) -> (RoomTransition, bool) {
        let now = self.now();
        let old = self.room.replace(snapshot.room);
        let previous_name = self.name.clone();
        let previous_vote = self.vote.clone();
        let local_player = self
            .room
            .as_ref()
            .and_then(|room| room.players.iter().find(|player| player.is_you))
            .map(|player| {
                let vote = match &player.vote {
                    Vote::Revealed(value) => Some(value.clone()),
                    Vote::Missing | Vote::Hidden => None,
                };
                (player.name.clone(), vote)
            });
        if let Some((name, _)) = &local_player {
            self.name.clone_from(name);
        }
        self.vote = local_player.and_then(|(_, vote)| vote);
        let first_room = old.is_none();
        if first_room {
            self.round_number = 1;
        } else if old.as_ref().map(|room| room.phase) != self.room.as_ref().map(|room| room.phase) {
            self.new_phase();
        }

        let mut changed = first_room
            || old.as_ref() != self.room.as_ref()
            || previous_name != self.name
            || previous_vote != self.vote;
        for log in snapshot.log {
            if self.seen_server_log_indexes.insert(log.server_index) {
                self.log.push(LogEntry {
                    timestamp: now,
                    level: log.level,
                    message: log.message,
                    source: LogSource::Server,
                    server_index: Some(log.server_index),
                });
                changed = true;
            }
        }
        (
            RoomTransition {
                previous_room: old,
                room: self
                    .room
                    .clone()
                    .expect("a room snapshot installs authoritative room state"),
                history_len: self.history.len(),
            },
            changed,
        )
    }

    fn new_phase(&mut self) {
        let room = self.room.as_ref().expect("phase changes require a room");
        if room.phase == GamePhase::Playing {
            self.round_number += 1;
        }

        if room.phase == GamePhase::Revealed {
            let entry = HistoryEntry {
                round_number: self.round_number,
                average: self.average_votes(),
                votes: room.players.clone(),
                deck: room.deck.clone(),
                own_vote: self.vote.clone(),
            };
            self.history.push(entry);
        }
    }

    pub fn vote(&mut self, data: &str) -> ClientResult<()> {
        let before = self.public_state();
        let result = (|| {
            self.ensure_ready()?;
            let room = self.room.as_ref().ok_or_else(|| {
                ClientError::not_ready("Authoritative room state is not available.")
            })?;
            if room.phase != GamePhase::Playing {
                return Err(ClientError::invalid_state(
                    "Cards can only be played during voting.",
                ));
            }
            let card = room
                .deck
                .iter()
                .find(|item| item.as_str() == data)
                .cloned()
                .ok_or_else(|| {
                    ClientError::invalid_card(format!("Card is not in the deck: {data}"))
                })?;

            let request =
                encode_vote(&card).map_err(|error| ClientError::protocol(error.to_string()))?;
            self.send_request(request)
        })();
        self.commit_operation(before, false);
        result
    }

    pub fn retract_vote(&mut self) -> ClientResult<()> {
        let before = self.public_state();
        let result = (|| {
            self.ensure_ready()?;
            let room = self.room.as_ref().ok_or_else(|| {
                ClientError::not_ready("Authoritative room state is not available.")
            })?;
            if room.phase == GamePhase::Playing {
                let request = encode_retract_vote()
                    .map_err(|error| ClientError::protocol(error.to_string()))?;
                self.send_request(request)
            } else {
                Err(ClientError::invalid_state(
                    "Votes can only be retracted during voting.",
                ))
            }
        })();
        self.commit_operation(before, false);
        result
    }

    pub fn rename(&mut self, data: String) -> ClientResult<()> {
        let before = self.public_state();
        let result = self.ensure_ready().and_then(|_| {
            encode_change_name(data.as_str())
                .map_err(|error| ClientError::protocol(error.to_string()))
                .and_then(|request| self.send_request(request))
        });
        self.commit_operation(before, false);
        result
    }

    pub fn chat(&mut self, message: String) -> ClientResult<()> {
        let before = self.public_state();
        let result = self.ensure_ready().and_then(|_| {
            encode_chat_message(message.as_str())
                .map_err(|error| ClientError::protocol(error.to_string()))
                .and_then(|request| self.send_request(request))
        });
        self.commit_operation(before, false);
        result
    }

    pub fn reveal(&mut self) -> ClientResult<()> {
        let before = self.public_state();
        let result = if let Err(error) = self.ensure_ready() {
            Err(error)
        } else if let Some(room) = self.room.as_ref() {
            if room.phase != GamePhase::Revealed {
                encode_reveal_cards()
                    .map_err(|error| ClientError::protocol(error.to_string()))
                    .and_then(|request| self.send_request(request))
            } else {
                Ok(())
            }
        } else {
            Err(ClientError::not_ready(
                "Authoritative room state is not available.",
            ))
        };
        self.commit_operation(before, false);
        result
    }

    pub fn restart(&mut self) -> ClientResult<()> {
        let before = self.public_state();
        let result = (|| {
            self.ensure_ready()?;
            let room = self.room.as_ref().ok_or_else(|| {
                ClientError::not_ready("Authoritative room state is not available.")
            })?;
            if room.phase == GamePhase::Revealed {
                let request = encode_start_new_round()
                    .map_err(|error| ClientError::protocol(error.to_string()))?;
                self.send_request(request)
            } else {
                Err(ClientError::invalid_state(
                    "A new round can only be started after cards are revealed.",
                ))
            }
        })();
        self.commit_operation(before, false);
        result
    }

    pub fn average_votes(&self) -> Option<f32> {
        let room = self.room.as_ref()?;
        if room.phase != GamePhase::Revealed {
            return None;
        }
        let mut sum = 0f32;
        let mut count = 0u32;
        for player in &room.players {
            if let Vote::Revealed(VoteData::Number(number)) = player.vote {
                sum += number as f32;
                count += 1;
            }
        }
        if count > 0 {
            Some(sum / count as f32)
        } else {
            None
        }
    }

    pub fn close(&mut self) -> bool {
        if self.status() == ConnectionStatus::Closed {
            return false;
        }
        let before = self.public_state();
        self.finish(None);
        self.commit_operation(before, false)
    }

    fn send_request(&mut self, body: String) -> ClientResult<()> {
        self.ensure_ready()?;
        let result = self
            .transport
            .as_mut()
            .expect("open clients retain their transport")
            .send_text(body);
        if let Err(message) = result {
            let error = ClientError::transport(message);
            self.finish(Some(error.clone()));
            return Err(error);
        }
        Ok(())
    }

    fn finish(&mut self, error: Option<ClientError>) {
        if self.status == ConnectionStatus::Closed {
            return;
        }
        if let Some(mut transport) = self.transport.take() {
            transport.close();
        }
        self.status = ConnectionStatus::Closed;
        self.terminal_error = error;
    }

    fn public_state(&self) -> PublicState {
        PublicState {
            status: self.status(),
            terminal_error: self.terminal_error.clone(),
        }
    }

    fn commit_operation(&mut self, before: PublicState, state_changed: bool) -> bool {
        if state_changed || before != self.public_state() {
            self.revision = self.revision.saturating_add(1);
            true
        } else {
            false
        }
    }
}

fn snapshot_average(average: Option<f32>) -> ClientResult<Option<f32>> {
    match average {
        Some(value) if !value.is_finite() => Err(ClientError::protocol(
            "Client snapshot contains an invalid average.",
        )),
        average => Ok(average),
    }
}

fn snapshot_duration_ms(duration: Duration) -> ClientResult<f64> {
    duration_ms(duration).map_err(|_| {
        ClientError::protocol(
            "Client snapshot contains a time outside the JavaScript safe integer range.",
        )
    })
}

impl Drop for Client {
    fn drop(&mut self) {
        if self.status() != ConnectionStatus::Closed {
            self.finish(None);
        }
    }
}

#[cfg(test)]
mod tests;
