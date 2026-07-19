use std::error::Error;
use std::fmt::{Display, Formatter};
use std::rc::Rc;
use std::time::Duration;

use log::warn;
use serde::Serialize;

use crate::models::{GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Room, Vote, VoteData};
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

pub trait PokerClient {
    fn ensure_ready(&self) -> ClientResult<()>;
    fn get_updates(&mut self) -> ClientResult<Vec<RoomSnapshot>>;
    fn vote(&mut self, card_value: Option<&str>) -> ClientResult<()>;
    fn change_name(&mut self, name: &str) -> ClientResult<()>;
    fn chat(&mut self, message: &str) -> ClientResult<()>;
    fn reveal(&mut self) -> ClientResult<()>;
    fn reset(&mut self) -> ClientResult<()>;
    fn close(&mut self);
}

pub struct WebPokerClient {
    transport: Option<Box<dyn Transport>>,
    status: ConnectionStatus,
    terminal_error: Option<ClientError>,
    pending_error: Option<ClientError>,
}

impl WebPokerClient {
    pub fn new() -> Self {
        Self {
            transport: None,
            status: ConnectionStatus::Disconnected,
            terminal_error: None,
            pending_error: None,
        }
    }

    pub fn connect(&mut self, mut transport: Box<dyn Transport>) -> ClientResult<()> {
        match self.status {
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
        }
    }

    pub fn status(&self) -> ConnectionStatus {
        self.status
    }

    pub fn terminal_error(&self) -> Option<&ClientError> {
        self.terminal_error.as_ref()
    }

    pub fn fail_transport(&mut self, message: impl Into<String>) -> ClientError {
        let error = ClientError::transport(message);
        self.finish(Some(error.clone()));
        error
    }

    pub fn get_update(&mut self) -> ClientResult<Option<RoomSnapshot>> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        self.read()
    }

    fn read(&mut self) -> ClientResult<Option<RoomSnapshot>> {
        loop {
            let event = match self.transport.as_mut() {
                Some(transport) => transport.poll_event(),
                None => return Ok(None),
            };
            match event {
                Some(TransportEvent::Opened) => {
                    self.status = ConnectionStatus::Open;
                }
                Some(TransportEvent::Text(text)) => {
                    return decode_room_snapshot(&text).map(Some).map_err(|error| {
                        let error = ClientError::protocol(error.to_string());
                        self.finish(Some(error.clone()));
                        error
                    });
                }
                Some(TransportEvent::Binary { length }) => {
                    warn!(
                        "Ignoring unsupported binary WebSocket message ({} bytes).",
                        length
                    );
                }
                Some(TransportEvent::Closed) => {
                    let error = ClientError::closed("Server closed connection.");
                    self.finish(None);
                    return Err(error);
                }
                Some(TransportEvent::Error(message)) => {
                    let error = ClientError::transport(message);
                    self.finish(Some(error.clone()));
                    return Err(error);
                }
                None => return Ok(None),
            }
        }
    }

    fn send_request(&mut self, body: String) -> ClientResult<()> {
        match self.status {
            ConnectionStatus::Open => {}
            ConnectionStatus::Closed => return Err(ClientError::closed("Client is closed.")),
            ConnectionStatus::Disconnected | ConnectionStatus::Connecting => {
                return Err(ClientError::not_ready("WebSocket connection is not open."));
            }
        }

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
}

impl Default for WebPokerClient {
    fn default() -> Self {
        Self::new()
    }
}

impl PokerClient for WebPokerClient {
    fn ensure_ready(&self) -> ClientResult<()> {
        match self.status {
            ConnectionStatus::Open => Ok(()),
            ConnectionStatus::Closed => Err(ClientError::closed("Client is closed.")),
            ConnectionStatus::Disconnected | ConnectionStatus::Connecting => {
                Err(ClientError::not_ready("WebSocket connection is not open."))
            }
        }
    }

    fn get_updates(&mut self) -> ClientResult<Vec<RoomSnapshot>> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        let mut result = vec![];
        loop {
            match self.read() {
                Ok(Some(update)) => result.push(update),
                Ok(None) => return Ok(result),
                Err(error) if !result.is_empty() => {
                    self.pending_error = Some(error);
                    return Ok(result);
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn vote(&mut self, card_value: Option<&str>) -> ClientResult<()> {
        let request = match card_value {
            Some(card_value) => encode_vote(card_value),
            None => encode_retract_vote(),
        }
        .map_err(|error| ClientError::protocol(error.to_string()))?;
        self.send_request(request)
    }

    fn change_name(&mut self, name: &str) -> ClientResult<()> {
        let request =
            encode_change_name(name).map_err(|error| ClientError::protocol(error.to_string()))?;
        self.send_request(request)
    }

    fn chat(&mut self, message: &str) -> ClientResult<()> {
        let request = encode_chat_message(message)
            .map_err(|error| ClientError::protocol(error.to_string()))?;
        self.send_request(request)
    }

    fn reveal(&mut self) -> ClientResult<()> {
        let request =
            encode_reveal_cards().map_err(|error| ClientError::protocol(error.to_string()))?;
        self.send_request(request)
    }

    fn reset(&mut self) -> ClientResult<()> {
        let request =
            encode_start_new_round().map_err(|error| ClientError::protocol(error.to_string()))?;
        self.send_request(request)
    }

    fn close(&mut self) {
        self.finish(None);
    }
}

impl Drop for WebPokerClient {
    fn drop(&mut self) {
        self.finish(None);
    }
}

pub struct Session {
    vote: Option<VoteData>,
    name: String,
    room: Option<Room>,
    log: Vec<LogEntry>,
    round_number: u32,
    round_start: Option<Duration>,
    history: Vec<HistoryEntry>,
    revision: u32,
    clock: Rc<dyn Clock>,
}

impl Session {
    pub fn new(name: String, clock: Rc<dyn Clock>) -> Self {
        Self {
            vote: None,
            name,
            room: None,
            log: vec![],
            round_number: 0,
            round_start: None,
            history: vec![],
            revision: 0,
            clock,
        }
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

    pub fn round_start(&self) -> Option<Duration> {
        self.round_start
    }

    pub fn history(&self) -> &[HistoryEntry] {
        &self.history
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    pub fn now(&self) -> Duration {
        self.clock.now()
    }

    pub fn round_elapsed(&self) -> Option<Duration> {
        self.round_start
            .map(|round_start| self.now().saturating_sub(round_start))
    }

    pub fn apply_room_snapshot(&mut self, snapshot: RoomSnapshot) -> Option<Room> {
        let (old, changed) = self.merge_room_snapshot(snapshot);
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        old
    }

    pub fn apply_poll_batch<I, F>(&mut self, snapshots: I, mut after_update: F)
    where
        I: IntoIterator<Item = RoomSnapshot>,
        F: FnMut(&Session, Option<Room>),
    {
        let mut changed = false;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for snapshot in snapshots {
                let (old, update_changed) = self.merge_room_snapshot(snapshot);
                changed |= update_changed;
                after_update(self, old);
            }
        }));
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }

    fn merge_room_snapshot(&mut self, snapshot: RoomSnapshot) -> (Option<Room>, bool) {
        let now = self.now();
        let old = self.room.replace(snapshot.room);
        let first_room = old.is_none();
        if first_room {
            self.round_number = 1;
            self.round_start = Some(now);
        } else if old.as_ref().map(|room| room.phase) != self.room.as_ref().map(|room| room.phase) {
            self.new_phase(now);
        }

        let mut changed = first_room || old.as_ref() != self.room.as_ref();
        for log in snapshot.log {
            if !self
                .log
                .iter()
                .any(|entry| entry.server_index == Some(log.server_index))
            {
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
        (old, changed)
    }

    fn new_phase(&mut self, now: Duration) {
        let room = self.room.as_ref().expect("phase changes require a room");
        if room.phase == GamePhase::Playing {
            self.vote = None;
            self.round_number += 1;
            self.round_start = Some(now);
        }

        if room.phase == GamePhase::Revealed {
            let entry = HistoryEntry {
                round_number: self.round_number,
                average: self.average_votes(),
                length: now.saturating_sub(self.round_start.unwrap_or(now)),
                votes: room.players.clone(),
                deck: room.deck.clone(),
                own_vote: self.vote.clone(),
            };
            self.history.push(entry);
        }
    }

    pub fn vote(&mut self, data: &str, client: &mut dyn PokerClient) -> ClientResult<()> {
        client.ensure_ready()?;
        let room = self
            .room
            .as_ref()
            .ok_or_else(|| ClientError::not_ready("Authoritative room state is not available."))?;
        let data = data.trim();
        if data == "-" {
            let changed = self.vote.take().is_some();
            if changed {
                self.mark_changed();
            }
            return client.vote(None);
        }

        if room.deck.iter().any(|item| item.eq_ignore_ascii_case(data)) {
            let vote = match data.parse::<u8>() {
                Ok(number) => VoteData::Number(number),
                Err(_) => VoteData::Special(data.to_string()),
            };
            client.vote(Some(format!("{}", &vote).as_str()))?;
            if self.vote.as_ref() != Some(&vote) {
                self.vote = Some(vote);
                self.mark_changed();
            }
        } else {
            self.log_message(
                LogLevel::Error,
                format!("Card is not in the deck: {}", data),
            );
        }
        Ok(())
    }

    pub fn rename(&mut self, data: String, client: &mut dyn PokerClient) -> ClientResult<()> {
        client.ensure_ready()?;
        if self.name != data {
            self.name = data;
            self.mark_changed();
        }
        client.change_name(self.name.as_str())
    }

    pub fn chat(&mut self, message: String, client: &mut dyn PokerClient) -> ClientResult<()> {
        client.ensure_ready()?;
        client.chat(message.as_str())
    }

    pub fn reveal(&mut self, client: &mut dyn PokerClient) -> ClientResult<()> {
        client.ensure_ready()?;
        let room = self
            .room
            .as_ref()
            .ok_or_else(|| ClientError::not_ready("Authoritative room state is not available."))?;
        if room.phase != GamePhase::Revealed {
            client.reveal()
        } else {
            Ok(())
        }
    }

    pub fn restart(&mut self, client: &mut dyn PokerClient) -> ClientResult<()> {
        client.ensure_ready()?;
        let phase = self
            .room
            .as_ref()
            .ok_or_else(|| ClientError::not_ready("Authoritative room state is not available."))?
            .phase;
        if self.vote.take().is_some() {
            self.mark_changed();
        }
        if phase != GamePhase::Playing {
            client.reset()
        } else {
            Ok(())
        }
    }

    pub fn average_votes(&self) -> Option<f32> {
        let room = self.room.as_ref()?;
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

    fn log_message(&mut self, level: LogLevel, message: String) {
        self.log.push(LogEntry {
            timestamp: self.now(),
            level,
            message,
            source: LogSource::Client,
            server_index: None,
        });
        self.mark_changed();
    }

    fn mark_changed(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    use crate::models::{LogLevel, Player, UserType};

    use super::*;

    #[derive(Default)]
    struct ManualClock {
        now: Cell<Duration>,
    }

    impl ManualClock {
        fn advance(&self, duration: Duration) {
            self.now.set(self.now.get() + duration);
        }
    }

    impl Clock for ManualClock {
        fn now(&self) -> Duration {
            self.now.get()
        }
    }

    struct PanickingClock {
        calls: Cell<usize>,
        panic_on: usize,
        now: Duration,
    }

    impl PanickingClock {
        fn new(panic_on: usize, now: Duration) -> Self {
            Self {
                calls: Cell::new(0),
                panic_on,
                now,
            }
        }
    }

    impl Clock for PanickingClock {
        fn now(&self) -> Duration {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            if call == self.panic_on {
                panic!("clock panic on call {call}");
            }
            self.now
        }
    }

    #[derive(Default)]
    struct FakeTransportState {
        events: VecDeque<TransportEvent>,
        sent: Vec<String>,
        send_error: Option<String>,
        closes: usize,
    }

    struct FakeTransport(Rc<RefCell<FakeTransportState>>);

    impl Transport for FakeTransport {
        fn poll_event(&mut self) -> Option<TransportEvent> {
            self.0.borrow_mut().events.pop_front()
        }

        fn send_text(&mut self, message: String) -> Result<(), String> {
            let mut state = self.0.borrow_mut();
            if let Some(error) = state.send_error.clone() {
                Err(error)
            } else {
                state.sent.push(message);
                Ok(())
            }
        }

        fn close(&mut self) {
            self.0.borrow_mut().closes += 1;
        }
    }

    fn fake_client(
        events: Vec<TransportEvent>,
    ) -> (WebPokerClient, Rc<RefCell<FakeTransportState>>) {
        let state = Rc::new(RefCell::new(FakeTransportState {
            events: events.into(),
            ..FakeTransportState::default()
        }));
        let mut client = WebPokerClient::new();
        client
            .connect(Box::new(FakeTransport(state.clone())))
            .unwrap();
        (client, state)
    }

    fn room_payload(phase: &str, votes: &[(&str, &str, bool)], logs: &[(&str, &str)]) -> String {
        serde_json::json!({
            "roomId": "test-room",
            "deck": ["1", "3", "5", "?"],
            "gamePhase": phase,
            "users": votes.iter().map(|(name, vote, is_you)| serde_json::json!({
                "username": name,
                "userType": "PARTICIPANT",
                "yourUser": is_you,
                "cardValue": vote,
            })).collect::<Vec<_>>(),
            "average": "0",
            "log": logs.iter().map(|(level, message)| serde_json::json!({
                "level": level,
                "message": message,
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    fn snapshot(payload: String) -> RoomSnapshot {
        decode_room_snapshot(&payload).unwrap()
    }

    fn session_with_phase(phase: &str) -> Session {
        let mut session = Session::new("Alice".to_string(), Rc::new(ManualClock::default()));
        session.apply_room_snapshot(snapshot(room_payload(phase, &[("Alice", "", true)], &[])));
        session
    }

    fn assert_error_code(result: ClientResult<()>, code: ClientErrorCode) {
        assert_eq!(result.unwrap_err().code, code);
    }

    #[test]
    fn transport_must_open_before_commands_are_handed_off() {
        let (mut client, state) = fake_client(vec![]);
        let error = client.vote(Some("5")).unwrap_err();
        assert_eq!(error.code, ClientErrorCode::NotReady);
        assert!(state.borrow().sent.is_empty());

        state.borrow_mut().events.push_back(TransportEvent::Opened);
        assert!(client.get_updates().unwrap().is_empty());
        client.vote(Some("5")).unwrap();
        assert_eq!(
            state.borrow().sent,
            [r#"{"requestType":"PlayCard","cardValue":"5"}"#]
        );
    }

    #[test]
    fn text_events_deliver_full_room_snapshots() {
        let payload = room_payload("PLAYING", &[("Alice", "5", true)], &[("INFO", "joined")]);
        let (mut client, _) =
            fake_client(vec![TransportEvent::Opened, TransportEvent::Text(payload)]);

        let updates = client.get_updates().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].room.name, "test-room");
        assert_eq!(updates[0].room.players[0].name, "Alice");
        assert_eq!(updates[0].log[0].message, "joined");
    }

    #[test]
    fn single_update_read_preserves_later_text_events_for_startup() {
        let first = room_payload("PLAYING", &[("Alice", "", true)], &[]);
        let second = room_payload("PLAYING", &[("Bob", "", true)], &[]);
        let (mut client, _) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Text(first),
            TransportEvent::Text(second),
        ]);

        let initial = client.get_update().unwrap().unwrap();
        assert_eq!(initial.room.players[0].name, "Alice");
        let remaining = client.get_updates().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].room.players[0].name, "Bob");
    }

    #[test]
    fn text_before_close_is_delivered_before_terminal_close() {
        let payload = room_payload("PLAYING", &[("Alice", "", true)], &[]);
        let (mut client, state) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Text(payload),
            TransportEvent::Closed,
        ]);

        let updates = client.get_updates().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].room.players[0].name, "Alice");
        assert_eq!(client.status(), ConnectionStatus::Closed);
        assert_eq!(state.borrow().closes, 1);
        assert_eq!(
            client.get_updates().unwrap_err().code,
            ClientErrorCode::Closed
        );
    }

    #[test]
    fn text_before_error_is_delivered_before_terminal_error() {
        let payload = room_payload("PLAYING", &[("Alice", "", true)], &[]);
        let (mut client, state) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Text(payload),
            TransportEvent::Error("network failed".to_string()),
        ]);

        let updates = client.get_updates().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].room.players[0].name, "Alice");
        assert_eq!(client.status(), ConnectionStatus::Closed);
        assert_eq!(state.borrow().closes, 1);
        let error = client.get_updates().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(error.message, "network failed");
    }

    #[test]
    fn close_and_errors_are_terminal_and_release_transport() {
        let (mut closed_client, closed_state) = fake_client(vec![TransportEvent::Closed]);
        let error = closed_client.get_updates().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Closed);
        assert_eq!(closed_client.status(), ConnectionStatus::Closed);
        assert!(closed_client.terminal_error().is_none());
        assert_eq!(closed_state.borrow().closes, 1);

        let (mut failed_client, failed_state) =
            fake_client(vec![TransportEvent::Error("network failed".to_string())]);
        let error = failed_client.get_updates().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(failed_client.terminal_error(), Some(&error));
        assert_eq!(failed_state.borrow().closes, 1);
    }

    #[test]
    fn unsupported_binary_is_ignored_without_corrupting_following_text() {
        let payload = room_payload("PLAYING", &[], &[]);
        let (mut client, _) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Binary { length: 3 },
            TransportEvent::Text(payload),
        ]);

        assert_eq!(client.get_updates().unwrap().len(), 1);
        assert_eq!(client.status(), ConnectionStatus::Open);
    }

    #[test]
    fn explicit_and_drop_cleanup_are_deterministic() {
        let (mut client, state) = fake_client(vec![]);
        client.close();
        client.close();
        assert_eq!(state.borrow().closes, 1);
        assert!(client.get_updates().unwrap().is_empty());
        assert_eq!(
            client.chat("after close").unwrap_err().code,
            ClientErrorCode::Closed
        );
        drop(client);
        assert_eq!(state.borrow().closes, 1);

        let (client, drop_state) = fake_client(vec![]);
        drop(client);
        assert_eq!(drop_state.borrow().closes, 1);
    }

    #[test]
    fn malformed_text_and_send_errors_close_and_cleanup() {
        let (mut malformed, malformed_state) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Text("not json".to_string()),
        ]);
        let error = malformed.get_updates().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Protocol);
        assert_eq!(malformed_state.borrow().closes, 1);

        let (mut failed_send, send_state) = fake_client(vec![TransportEvent::Opened]);
        failed_send.get_updates().unwrap();
        send_state.borrow_mut().send_error = Some("send failed".to_string());
        let error = failed_send.chat("hello").unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(send_state.borrow().closes, 1);
    }

    #[test]
    fn transport_creation_failures_can_be_recorded_before_connect() {
        let mut client = WebPokerClient::new();

        let error = client.fail_transport("socket construction failed");

        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(client.status(), ConnectionStatus::Closed);
        assert_eq!(client.terminal_error(), Some(&error));
        assert_eq!(
            client
                .connect(Box::new(FakeTransport(Rc::new(RefCell::new(
                    FakeTransportState::default()
                )))))
                .unwrap_err()
                .code,
            ClientErrorCode::Closed
        );
    }

    #[test]
    fn repeated_connect_is_idempotent_and_post_close_connect_fails() {
        let (mut client, first_state) = fake_client(vec![]);
        let second_state = Rc::new(RefCell::new(FakeTransportState::default()));
        client
            .connect(Box::new(FakeTransport(second_state.clone())))
            .unwrap();
        assert_eq!(second_state.borrow().closes, 1);
        assert_eq!(first_state.borrow().closes, 0);

        client.close();
        let third_state = Rc::new(RefCell::new(FakeTransportState::default()));
        let error = client
            .connect(Box::new(FakeTransport(third_state.clone())))
            .unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Closed);
        assert_eq!(third_state.borrow().closes, 1);
    }

    #[test]
    fn all_commands_check_readiness_before_validation_and_noop_policy() {
        let (mut client, state) = fake_client(vec![]);
        let mut playing = session_with_phase("PLAYING");
        playing.vote = Some(VoteData::Number(3));
        let mut revealed = session_with_phase("CARDS_REVEALED");
        let playing_revision = playing.revision();
        let revealed_revision = revealed.revision();

        assert_error_code(playing.vote("5", &mut client), ClientErrorCode::NotReady);
        assert_error_code(
            playing.vote("not-a-card", &mut client),
            ClientErrorCode::NotReady,
        );
        assert_error_code(playing.vote("-", &mut client), ClientErrorCode::NotReady);
        assert_error_code(
            playing.rename("Alicia".to_string(), &mut client),
            ClientErrorCode::NotReady,
        );
        assert_error_code(
            playing.chat("hello".to_string(), &mut client),
            ClientErrorCode::NotReady,
        );
        assert_error_code(playing.restart(&mut client), ClientErrorCode::NotReady);
        assert_error_code(revealed.reveal(&mut client), ClientErrorCode::NotReady);
        assert_eq!(playing.own_vote(), &Some(VoteData::Number(3)));
        assert_eq!(playing.name(), "Alice");
        assert_eq!(playing.revision(), playing_revision);
        assert_eq!(revealed.revision(), revealed_revision);
        assert!(state.borrow().sent.is_empty());

        client.close();
        assert_error_code(playing.vote("5", &mut client), ClientErrorCode::Closed);
        assert_error_code(
            playing.vote("not-a-card", &mut client),
            ClientErrorCode::Closed,
        );
        assert_error_code(playing.vote("-", &mut client), ClientErrorCode::Closed);
        assert_error_code(
            playing.rename("Alicia".to_string(), &mut client),
            ClientErrorCode::Closed,
        );
        assert_error_code(
            playing.chat("hello".to_string(), &mut client),
            ClientErrorCode::Closed,
        );
        assert_error_code(playing.restart(&mut client), ClientErrorCode::Closed);
        assert_error_code(revealed.reveal(&mut client), ClientErrorCode::Closed);
        assert_eq!(playing.own_vote(), &Some(VoteData::Number(3)));
        assert_eq!(playing.name(), "Alice");
        assert_eq!(playing.revision(), playing_revision);
        assert_eq!(revealed.revision(), revealed_revision);
        assert!(state.borrow().sent.is_empty());
    }

    #[test]
    fn command_failure_preserves_native_local_mutation_ordering() {
        let mut retraction = session_with_phase("PLAYING");
        retraction.vote = Some(VoteData::Number(5));
        let (mut retraction_client, retraction_state) = fake_client(vec![TransportEvent::Opened]);
        retraction_client.get_updates().unwrap();
        retraction_state.borrow_mut().send_error = Some("send failed".to_string());
        let revision = retraction.revision();
        assert_error_code(
            retraction.vote("-", &mut retraction_client),
            ClientErrorCode::Transport,
        );
        assert_eq!(retraction.own_vote(), &None);
        assert_eq!(retraction.revision(), revision + 1);

        let mut rename = session_with_phase("PLAYING");
        let (mut rename_client, rename_state) = fake_client(vec![TransportEvent::Opened]);
        rename_client.get_updates().unwrap();
        rename_state.borrow_mut().send_error = Some("send failed".to_string());
        let revision = rename.revision();
        assert_error_code(
            rename.rename("Alicia".to_string(), &mut rename_client),
            ClientErrorCode::Transport,
        );
        assert_eq!(rename.name(), "Alicia");
        assert_eq!(rename.revision(), revision + 1);

        for card in ["5", "?"] {
            let mut vote = session_with_phase("PLAYING");
            let (mut vote_client, vote_state) = fake_client(vec![TransportEvent::Opened]);
            vote_client.get_updates().unwrap();
            vote_state.borrow_mut().send_error = Some("send failed".to_string());
            let revision = vote.revision();
            assert_error_code(
                vote.vote(card, &mut vote_client),
                ClientErrorCode::Transport,
            );
            assert_eq!(vote.own_vote(), &None);
            assert_eq!(vote.revision(), revision);
        }
    }

    #[test]
    fn poll_batch_and_repeated_commands_have_precise_revisions() {
        let mut session = Session::new("Alice".to_string(), Rc::new(ManualClock::default()));
        let updates = vec![
            snapshot(room_payload("PLAYING", &[("Alice", "", true)], &[])),
            snapshot(room_payload("CARDS_REVEALED", &[("Alice", "5", true)], &[])),
        ];
        let mut transitions = vec![];
        session.apply_poll_batch(updates, |session, old| {
            transitions.push((
                old.map(|room| room.phase),
                session.room().unwrap().phase,
                session.revision(),
            ));
        });
        assert_eq!(
            transitions,
            [
                (None, GamePhase::Playing, 0),
                (Some(GamePhase::Playing), GamePhase::Revealed, 0),
            ]
        );
        assert_eq!(session.history().len(), 1);
        assert_eq!(session.revision(), 1);
        session.apply_poll_batch(Vec::new(), |_, _| unreachable!());
        assert_eq!(session.revision(), 1);

        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true)],
            &[],
        )));
        let (mut client, _) = fake_client(vec![TransportEvent::Opened]);
        client.get_updates().unwrap();

        let revision = session.revision();
        session.vote("5", &mut client).unwrap();
        assert_eq!(session.revision(), revision + 1);
        session.vote("5", &mut client).unwrap();
        assert_eq!(session.revision(), revision + 1);

        session.rename("Alicia".to_string(), &mut client).unwrap();
        assert_eq!(session.revision(), revision + 2);
        session.rename("Alicia".to_string(), &mut client).unwrap();
        assert_eq!(session.revision(), revision + 2);

        session.chat("hello".to_string(), &mut client).unwrap();
        session.reveal(&mut client).unwrap();
        assert_eq!(session.revision(), revision + 2);

        session.restart(&mut client).unwrap();
        assert_eq!(session.revision(), revision + 3);
        session.restart(&mut client).unwrap();
        assert_eq!(session.revision(), revision + 3);
    }

    #[test]
    fn panicking_batch_callback_commits_revision_and_leaves_session_usable() {
        let mut session = Session::new("Alice".to_string(), Rc::new(ManualClock::default()));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.apply_poll_batch(
                vec![snapshot(room_payload(
                    "PLAYING",
                    &[("Alice", "", true)],
                    &[],
                ))],
                |session, _| {
                    assert_eq!(session.room().unwrap().phase, GamePhase::Playing);
                    panic!("callback panic");
                },
            );
        }));

        assert!(result.is_err());
        assert_eq!(session.revision(), 1);
        assert_eq!(session.room().unwrap().phase, GamePhase::Playing);

        let mut callbacks = 0;
        session.apply_poll_batch(
            vec![snapshot(room_payload(
                "CARDS_REVEALED",
                &[("Alice", "5", true)],
                &[],
            ))],
            |_, _| callbacks += 1,
        );
        assert_eq!(callbacks, 1);
        assert_eq!(session.revision(), 2);
        assert_eq!(session.room().unwrap().phase, GamePhase::Revealed);
        assert_eq!(session.history().len(), 1);
    }

    #[test]
    fn iterator_panic_after_changed_snapshot_commits_one_revision() {
        let mut session = Session::new("Alice".to_string(), Rc::new(ManualClock::default()));
        let updates = std::iter::once(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true)],
            &[],
        )))
        .chain(std::iter::from_fn(|| -> Option<RoomSnapshot> {
            panic!("iterator panic")
        }));
        let mut callbacks = 0;

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.apply_poll_batch(updates, |_, _| callbacks += 1);
        }));

        assert!(result.is_err());
        assert_eq!(callbacks, 1);
        assert_eq!(session.revision(), 1);
        assert_eq!(session.room().unwrap().phase, GamePhase::Playing);
    }

    #[test]
    fn session_commands_preserve_validation_local_state_and_json_handoff() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock);
        let absent_error = session.vote("5", &mut fake_client(vec![]).0).unwrap_err();
        assert_eq!(absent_error.code, ClientErrorCode::NotReady);

        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true)],
            &[],
        )));
        let (mut client, state) = fake_client(vec![TransportEvent::Opened]);
        client.get_updates().unwrap();

        session.vote(" 5 ", &mut client).unwrap();
        assert_eq!(session.vote, Some(VoteData::Number(5)));
        session.vote("?", &mut client).unwrap();
        assert_eq!(session.vote, Some(VoteData::Special("?".to_string())));
        session.vote("-", &mut client).unwrap();
        assert_eq!(session.vote, None);
        session.rename("Alicia".to_string(), &mut client).unwrap();
        session.chat("hello".to_string(), &mut client).unwrap();
        session.reveal(&mut client).unwrap();
        session.restart(&mut client).unwrap();

        assert_eq!(session.name, "Alicia");
        assert_eq!(
            state.borrow().sent,
            [
                r#"{"requestType":"PlayCard","cardValue":"5"}"#,
                r#"{"requestType":"PlayCard","cardValue":"?"}"#,
                r#"{"requestType":"PlayCard","cardValue":null}"#,
                r#"{"requestType":"ChangeName","name":"Alicia"}"#,
                r#"{"requestType":"ChatMessage","message":"hello"}"#,
                r#"{"requestType":"RevealCards"}"#,
            ]
        );

        session.vote("not-a-card", &mut client).unwrap();
        assert_eq!(session.log.last().unwrap().level, LogLevel::Error);
        assert_eq!(state.borrow().sent.len(), 6);
    }

    #[test]
    fn revealed_session_commands_do_not_repeat_reveal_and_do_handoff_reset() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock);
        session.apply_room_snapshot(snapshot(room_payload(
            "CARDS_REVEALED",
            &[("Alice", "3", true)],
            &[],
        )));
        let (mut client, state) = fake_client(vec![TransportEvent::Opened]);
        client.get_updates().unwrap();

        let revision = session.revision();
        session.reveal(&mut client).unwrap();
        session.restart(&mut client).unwrap();

        assert_eq!(state.borrow().sent, [r#"{"requestType":"StartNewRound"}"#]);
        assert_eq!(session.revision(), revision);
    }

    #[test]
    fn room_updates_deduplicate_server_logs_and_do_not_fabricate_initial_history() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock.clone());
        assert!(session.room().is_none());
        assert_eq!(session.round_number, 0);

        let playing = room_payload(
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[("INFO", "first")],
        );
        session.apply_room_snapshot(snapshot(playing));
        clock.advance(Duration::from_secs(4));
        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[("INFO", "first"), ("CHAT", "second")],
        )));

        assert_eq!(session.log.len(), 2);
        assert_eq!(session.log[0].timestamp, Duration::ZERO);
        assert_eq!(session.log[1].timestamp, Duration::from_secs(4));
        assert_eq!(session.round_number, 1);
        assert!(session.history.is_empty());
    }

    #[test]
    fn authoritative_snapshot_samples_clock_once_before_mutation() {
        let clock = Rc::new(PanickingClock::new(2, Duration::from_secs(7)));
        let mut session = Session::new("Alice".to_string(), clock.clone());

        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true)],
            &[("INFO", "first"), ("CHAT", "second")],
        )));

        assert_eq!(clock.calls.get(), 1);
        assert_eq!(session.revision(), 1);
        assert_eq!(session.room().unwrap().phase, GamePhase::Playing);
        assert_eq!(session.round_start(), Some(Duration::from_secs(7)));
        assert_eq!(session.log().len(), 2);
        assert!(session
            .log()
            .iter()
            .all(|entry| entry.timestamp == Duration::from_secs(7)));
    }

    #[test]
    fn first_clock_sample_panic_leaves_session_unchanged() {
        let clock = Rc::new(PanickingClock::new(1, Duration::from_secs(7)));
        let mut session = Session::new("Alice".to_string(), clock.clone());
        let update = snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true)],
            &[("INFO", "first")],
        ));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.apply_room_snapshot(update);
        }));

        assert!(result.is_err());
        assert_eq!(clock.calls.get(), 1);
        assert_eq!(session.revision(), 0);
        assert!(session.room().is_none());
        assert_eq!(session.round_number(), 0);
        assert_eq!(session.round_start(), None);
        assert!(session.log().is_empty());
        assert!(session.history().is_empty());
    }

    #[test]
    fn phase_transitions_record_optional_average_and_fixed_clock_duration() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock.clone());
        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[],
        )));
        clock.advance(Duration::from_millis(2500));
        session.apply_room_snapshot(snapshot(room_payload(
            "CARDS_REVEALED",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[],
        )));

        assert_eq!(session.average_votes(), Some(4.0));
        assert_eq!(session.history.len(), 1);
        assert_eq!(session.history[0].average, Some(4.0));
        assert_eq!(session.history[0].length, Duration::from_millis(2500));

        clock.advance(Duration::from_secs(10));
        assert_eq!(session.history[0].length, Duration::from_millis(2500));
        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "", true), ("Bob", "", false)],
            &[],
        )));
        assert_eq!(session.round_number, 2);
        assert_eq!(session.round_start, Some(Duration::from_millis(12500)));
    }

    #[test]
    fn absent_numeric_votes_have_no_non_finite_average() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock);
        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Alice", "?", true)],
            &[],
        )));
        session.apply_room_snapshot(snapshot(room_payload(
            "CARDS_REVEALED",
            &[("Alice", "?", true)],
            &[],
        )));

        assert_eq!(session.average_votes(), None);
        assert_eq!(session.history[0].average, None);
    }

    #[test]
    fn advancing_time_and_reading_elapsed_do_not_change_revision() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock.clone());
        session.apply_room_snapshot(snapshot(room_payload("PLAYING", &[], &[])));
        let revision = session.revision;

        clock.advance(Duration::from_secs(9));
        assert_eq!(session.round_elapsed(), Some(Duration::from_secs(9)));
        assert_eq!(session.revision, revision);
    }

    #[test]
    fn session_keeps_room_player_order_and_own_vote_in_history() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Session::new("Alice".to_string(), clock.clone());
        session.apply_room_snapshot(snapshot(room_payload(
            "PLAYING",
            &[("Bob", "✅", false), ("Alice", "3", true)],
            &[],
        )));
        session.vote = Some(VoteData::Number(3));
        clock.advance(Duration::from_secs(1));
        session.apply_room_snapshot(snapshot(room_payload(
            "CARDS_REVEALED",
            &[("Bob", "5", false), ("Alice", "3", true)],
            &[],
        )));

        assert_eq!(
            session.history[0]
                .votes
                .iter()
                .map(|player: &Player| player.name.as_str())
                .collect::<Vec<_>>(),
            ["Bob", "Alice"]
        );
        assert_eq!(session.history[0].own_vote, Some(VoteData::Number(3)));
        assert!(session
            .room()
            .unwrap()
            .players
            .iter()
            .all(|player| player.user_type == UserType::Player));
    }
}
