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

    fn poll_inner(&mut self, stop_after_room: bool) -> ClientResult<PollOutcome> {
        let before = self.public_state();
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }

        let mut state_changed = false;
        let mut updates = vec![];
        loop {
            let event = match self.transport.as_mut() {
                Some(transport) => transport.poll_event(),
                None => None,
            };
            let error = match event {
                Some(TransportEvent::Opened) => {
                    self.status = ConnectionStatus::Open;
                    None
                }
                Some(TransportEvent::Text(text)) => match decode_room_snapshot(&text) {
                    Ok(snapshot) => {
                        let (transition, changed) = self.merge_room_snapshot(snapshot);
                        state_changed |= changed;
                        updates.push(ClientUpdate::Room(transition));
                        if stop_after_room {
                            break;
                        }
                        None
                    }
                    Err(error) => {
                        let error = ClientError::protocol(error.to_string());
                        self.finish(Some(error.clone()));
                        Some(error)
                    }
                },
                Some(TransportEvent::Binary { length }) => {
                    warn!(
                        "Ignoring unsupported binary WebSocket message ({} bytes).",
                        length
                    );
                    None
                }
                Some(TransportEvent::Closed) => {
                    let error = ClientError::closed("Server closed connection.");
                    self.finish(None);
                    Some(error)
                }
                Some(TransportEvent::Error(message)) => {
                    let error = ClientError::transport(message);
                    self.finish(Some(error.clone()));
                    Some(error)
                }
                None => break,
            };

            if let Some(error) = error {
                if updates.is_empty() {
                    self.commit_operation(before, state_changed);
                    return Err(error);
                }
                self.pending_error = Some(error);
                break;
            }
        }

        let changed = self.commit_operation(before, state_changed);
        Ok(PollOutcome { changed, updates })
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

    fn fake_client_with_clock(
        events: Vec<TransportEvent>,
        clock: Rc<dyn Clock>,
    ) -> (Client, Rc<RefCell<FakeTransportState>>) {
        let state = Rc::new(RefCell::new(FakeTransportState {
            events: events.into(),
            ..FakeTransportState::default()
        }));
        let mut client = Client::new("Alice".to_string(), clock);
        client
            .connect(Box::new(FakeTransport(state.clone())))
            .unwrap();
        (client, state)
    }

    fn fake_client(events: Vec<TransportEvent>) -> (Client, Rc<RefCell<FakeTransportState>>) {
        fake_client_with_clock(events, Rc::new(ManualClock::default()))
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

    fn room_snapshot(
        phase: &str,
        votes: &[(&str, &str, bool)],
        logs: &[(&str, &str)],
    ) -> RoomSnapshot {
        snapshot(room_payload(phase, votes, logs))
    }

    fn apply_votes(client: &mut Client, phase: &str, votes: &[(&str, &str, bool)]) {
        client.apply_room_snapshot(room_snapshot(phase, votes, &[]));
    }

    fn room_event(phase: &str, votes: &[(&str, &str, bool)]) -> TransportEvent {
        TransportEvent::Text(room_payload(phase, votes, &[]))
    }

    fn enqueue(state: &Rc<RefCell<FakeTransportState>>, event: TransportEvent) {
        state.borrow_mut().events.push_back(event);
    }

    fn new_client(clock: Rc<dyn Clock>) -> Client {
        Client::new("Alice".to_string(), clock)
    }

    fn client_with_phase(phase: &str) -> Client {
        let mut client = new_client(Rc::new(ManualClock::default()));
        apply_votes(&mut client, phase, &[("Alice", "", true)]);
        client
    }

    fn open_client_with_phase(
        phase: &str,
        clock: Rc<dyn Clock>,
    ) -> (Client, Rc<RefCell<FakeTransportState>>) {
        let (mut client, state) = fake_client_with_clock(
            vec![
                TransportEvent::Opened,
                room_event(phase, &[("Alice", "", true)]),
            ],
            clock,
        );
        client.poll().unwrap();
        (client, state)
    }

    fn assert_error_code(result: ClientResult<()>, code: ClientErrorCode) {
        assert_eq!(result.unwrap_err().code, code);
    }

    fn assert_command_errors(playing: &mut Client, revealed: &mut Client, code: ClientErrorCode) {
        for result in [
            playing.vote("5"),
            playing.vote("not-a-card"),
            playing.vote("-"),
            playing.retract_vote(),
            playing.rename("Alicia".to_string()),
            playing.chat("hello".to_string()),
            playing.restart(),
            revealed.reveal(),
        ] {
            assert_error_code(result, code);
        }
    }

    fn room_transition(update: &ClientUpdate) -> &RoomTransition {
        match update {
            ClientUpdate::Room(transition) => transition,
        }
    }

    #[test]
    fn transport_must_open_before_commands_are_handed_off() {
        let (mut client, state) = fake_client(vec![]);
        let error = client.vote("5").unwrap_err();
        assert_eq!(error.code, ClientErrorCode::NotReady);
        assert!(state.borrow().sent.is_empty());

        enqueue(&state, TransportEvent::Opened);
        enqueue(&state, room_event("PLAYING", &[("Alice", "", true)]));
        client.poll().unwrap();
        client.vote("5").unwrap();
        assert_eq!(state.borrow().sent.len(), 1);
    }

    #[test]
    fn text_events_deliver_full_room_snapshots() {
        let payload = room_payload("PLAYING", &[("Alice", "5", true)], &[("INFO", "joined")]);
        let (mut client, _) =
            fake_client(vec![TransportEvent::Opened, TransportEvent::Text(payload)]);

        let outcome = client.poll().unwrap();
        assert_eq!(outcome.updates.len(), 1);
        assert_eq!(room_transition(&outcome.updates[0]).room.name, "test-room");
        assert_eq!(client.room().unwrap().players[0].name, "Alice");
        assert_eq!(client.log()[0].message, "joined");
    }

    #[test]
    fn poll_applies_all_available_room_snapshots_in_order() {
        let (mut client, _) = fake_client(vec![
            TransportEvent::Opened,
            room_event("PLAYING", &[("Alice", "", true)]),
            room_event("PLAYING", &[("Bob", "", true)]),
        ]);

        let outcome = client.poll().unwrap();
        assert_eq!(outcome.updates.len(), 2);
        assert_eq!(
            room_transition(&outcome.updates[0]).room.players[0].name,
            "Alice"
        );
        assert_eq!(
            room_transition(&outcome.updates[1]).room.players[0].name,
            "Bob"
        );
        assert_eq!(client.room().unwrap().players[0].name, "Bob");
    }

    #[test]
    fn poll_next_room_leaves_later_snapshots_and_terminal_events_queued() {
        let (mut client, state) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Binary { length: 3 },
            room_event("PLAYING", &[("Alice", "", true)]),
            room_event("CARDS_REVEALED", &[("Alice", "5", true)]),
            TransportEvent::Error("after rooms".to_string()),
        ]);

        let first = client.poll_next_room().unwrap();
        assert_eq!(first.updates.len(), 1);
        assert_eq!(
            room_transition(&first.updates[0]).room.phase,
            GamePhase::Playing
        );
        assert_eq!(client.status(), ConnectionStatus::Open);
        assert_eq!(state.borrow().closes, 0);

        let second = client.poll().unwrap();
        assert_eq!(second.updates.len(), 1);
        assert_eq!(
            room_transition(&second.updates[0]).room.phase,
            GamePhase::Revealed
        );
        assert_eq!(client.status(), ConnectionStatus::Closed);
        let error = client.poll().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(error.message, "after rooms");
    }

    #[test]
    fn text_is_delivered_before_each_terminal_variant() {
        for (terminal, code, message) in [
            (TransportEvent::Closed, ClientErrorCode::Closed, None),
            (
                TransportEvent::Error("network failed".to_string()),
                ClientErrorCode::Transport,
                Some("network failed"),
            ),
        ] {
            let (mut client, state) = fake_client(vec![
                TransportEvent::Opened,
                room_event("PLAYING", &[("Alice", "", true)]),
                terminal,
            ]);

            let outcome = client.poll().unwrap();
            assert_eq!(outcome.updates.len(), 1);
            assert_eq!(
                room_transition(&outcome.updates[0]).room.players[0].name,
                "Alice"
            );
            assert_eq!(client.status(), ConnectionStatus::Closed);
            assert_eq!(state.borrow().closes, 1);
            let error = client.poll().unwrap_err();
            assert_eq!(error.code, code);
            if let Some(message) = message {
                assert_eq!(error.message, message);
            }
        }
    }

    #[test]
    fn close_and_errors_are_terminal_and_release_transport() {
        let (mut closed_client, closed_state) = fake_client(vec![TransportEvent::Closed]);
        let revision = closed_client.revision();
        let error = closed_client.poll().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Closed);
        assert_eq!(closed_client.status(), ConnectionStatus::Closed);
        assert!(closed_client.terminal_error().is_none());
        assert_eq!(closed_state.borrow().closes, 1);
        assert_eq!(closed_client.revision(), revision + 1);

        let (mut failed_client, failed_state) =
            fake_client(vec![TransportEvent::Error("network failed".to_string())]);
        let revision = failed_client.revision();
        let error = failed_client.poll().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(failed_client.terminal_error(), Some(&error));
        assert_eq!(failed_state.borrow().closes, 1);
        assert_eq!(failed_client.revision(), revision + 1);
    }

    #[test]
    fn unsupported_binary_is_ignored_without_corrupting_following_text() {
        let payload = room_payload("PLAYING", &[], &[]);
        let (mut client, _) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Binary { length: 3 },
            TransportEvent::Text(payload),
        ]);

        assert_eq!(client.poll().unwrap().updates.len(), 1);
        assert_eq!(client.status(), ConnectionStatus::Open);
    }

    #[test]
    fn explicit_and_drop_cleanup_are_deterministic() {
        let (mut client, state) = fake_client(vec![]);
        client.close();
        client.close();
        assert_eq!(state.borrow().closes, 1);
        assert!(client.poll().unwrap().updates.is_empty());
        assert_eq!(
            client.chat("after close".to_string()).unwrap_err().code,
            ClientErrorCode::Closed
        );
        drop(client);
        assert_eq!(state.borrow().closes, 1);

        let (client, drop_state) = fake_client(vec![]);
        drop(client);
        assert_eq!(drop_state.borrow().closes, 1);
    }

    #[test]
    fn connection_only_poll_commits_one_revision() {
        let (mut client, _) = fake_client(vec![TransportEvent::Opened]);
        let revision = client.revision();

        assert!(client.poll().unwrap().changed);
        assert_eq!(client.status(), ConnectionStatus::Open);
        assert_eq!(client.revision(), revision + 1);
        assert!(!client.poll().unwrap().changed);
        assert_eq!(client.revision(), revision + 1);
    }

    #[test]
    fn malformed_text_and_send_errors_close_and_cleanup() {
        let (mut malformed, malformed_state) = fake_client(vec![
            TransportEvent::Opened,
            TransportEvent::Text("not json".to_string()),
        ]);
        let error = malformed.poll().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Protocol);
        assert_eq!(malformed_state.borrow().closes, 1);

        let (mut failed_send, send_state) = fake_client(vec![
            TransportEvent::Opened,
            room_event("PLAYING", &[("Alice", "", true)]),
        ]);
        failed_send.poll().unwrap();
        send_state.borrow_mut().send_error = Some("send failed".to_string());
        let error = failed_send.chat("hello".to_string()).unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(send_state.borrow().closes, 1);
    }

    #[test]
    fn transport_creation_failures_can_be_recorded_before_connect() {
        let mut client = new_client(Rc::new(ManualClock::default()));

        let error = client.fail_transport("socket construction failed");

        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(client.status(), ConnectionStatus::Closed);
        assert_eq!(client.terminal_error(), Some(&error));
        let revision = client.revision();
        client.fail_transport("ignored after close");
        assert_eq!(client.terminal_error(), Some(&error));
        assert_eq!(client.revision(), revision);
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
        let mut playing = client_with_phase("PLAYING");
        playing.vote = Some(VoteData::Number(3));
        let mut revealed = client_with_phase("CARDS_REVEALED");
        let playing_revision = playing.revision();
        let revealed_revision = revealed.revision();

        assert_command_errors(&mut playing, &mut revealed, ClientErrorCode::NotReady);
        assert_eq!(playing.own_vote(), &Some(VoteData::Number(3)));
        assert_eq!(playing.name(), "Alice");
        assert_eq!(playing.revision(), playing_revision);
        assert_eq!(revealed.revision(), revealed_revision);
        assert_eq!(playing.status(), ConnectionStatus::Disconnected);

        playing.close();
        revealed.close();
        let playing_revision = playing.revision();
        let revealed_revision = revealed.revision();
        assert_command_errors(&mut playing, &mut revealed, ClientErrorCode::Closed);
        assert_eq!(playing.own_vote(), &Some(VoteData::Number(3)));
        assert_eq!(playing.name(), "Alice");
        assert_eq!(playing.revision(), playing_revision);
        assert_eq!(revealed.revision(), revealed_revision);
    }

    #[test]
    fn command_failures_do_not_mutate_authoritative_local_fields() {
        let (mut retraction, retraction_state) =
            open_client_with_phase("PLAYING", Rc::new(ManualClock::default()));
        retraction.vote = Some(VoteData::Number(5));
        retraction_state.borrow_mut().send_error = Some("send failed".to_string());
        let revision = retraction.revision();
        let error = retraction.retract_vote().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Transport);
        assert_eq!(retraction.own_vote(), &Some(VoteData::Number(5)));
        assert_eq!(retraction.status(), ConnectionStatus::Closed);
        assert_eq!(retraction.terminal_error(), Some(&error));
        assert_eq!(retraction.revision(), revision + 1);
        assert_error_code(retraction.retract_vote(), ClientErrorCode::Closed);
        assert_eq!(retraction.revision(), revision + 1);

        let (mut rename, rename_state) =
            open_client_with_phase("PLAYING", Rc::new(ManualClock::default()));
        rename_state.borrow_mut().send_error = Some("send failed".to_string());
        let revision = rename.revision();
        assert_error_code(
            rename.rename("Alicia".to_string()),
            ClientErrorCode::Transport,
        );
        assert_eq!(rename.name(), "Alice");
        assert_eq!(rename.revision(), revision + 1);

        for card in ["5", "?"] {
            let (mut vote, vote_state) =
                open_client_with_phase("PLAYING", Rc::new(ManualClock::default()));
            vote_state.borrow_mut().send_error = Some("send failed".to_string());
            let revision = vote.revision();
            assert_error_code(vote.vote(card), ClientErrorCode::Transport);
            assert_eq!(vote.own_vote(), &None);
            assert_eq!(vote.revision(), revision + 1);
        }

        let (mut restart, restart_state) =
            open_client_with_phase("CARDS_REVEALED", Rc::new(ManualClock::default()));
        restart_state.borrow_mut().send_error = Some("send failed".to_string());
        let revision = restart.revision();
        let room = restart.room().cloned();
        assert_error_code(restart.restart(), ClientErrorCode::Transport);
        assert_eq!(restart.room(), room.as_ref());
        assert_eq!(restart.own_vote(), &None);
        assert_eq!(restart.revision(), revision + 1);
    }

    #[test]
    fn poll_batch_and_repeated_commands_have_precise_revisions() {
        let (mut client, state) = fake_client(vec![
            TransportEvent::Opened,
            room_event("PLAYING", &[("Alice", "", true)]),
            room_event("CARDS_REVEALED", &[("Alice", "5", true)]),
        ]);
        let revision = client.revision();
        let outcome = client.poll().unwrap();
        assert!(outcome.changed);
        assert_eq!(
            outcome
                .updates
                .iter()
                .map(room_transition)
                .map(|transition| (
                    transition.previous_room.as_ref().map(|room| room.phase),
                    transition.room.phase,
                    transition.history_len,
                ))
                .collect::<Vec<_>>(),
            [
                (None, GamePhase::Playing, 0),
                (Some(GamePhase::Playing), GamePhase::Revealed, 1),
            ]
        );
        assert_eq!(client.history().len(), 1);
        assert_eq!(client.revision(), revision + 1);
        assert!(!client.poll().unwrap().changed);
        assert_eq!(client.revision(), revision + 1);

        enqueue(&state, room_event("PLAYING", &[("Alice", "", true)]));
        client.poll().unwrap();

        let revision = client.revision();
        client.vote("5").unwrap();
        assert_eq!(client.revision(), revision);
        client.vote("5").unwrap();
        assert_eq!(client.revision(), revision);

        client.rename("Alicia".to_string()).unwrap();
        assert_eq!(client.revision(), revision);
        client.rename("Alicia".to_string()).unwrap();
        assert_eq!(client.revision(), revision);

        client.chat("hello".to_string()).unwrap();
        client.reveal().unwrap();
        assert_eq!(client.revision(), revision);

        assert_error_code(client.restart(), ClientErrorCode::InvalidState);
        assert_eq!(client.revision(), revision);

        enqueue(
            &state,
            room_event("CARDS_REVEALED", &[("Alice", "5", true)]),
        );
        client.poll().unwrap();
        assert_eq!(client.revision(), revision + 1);
        client.restart().unwrap();
        assert_eq!(client.revision(), revision + 1);
    }

    #[test]
    fn commands_use_canonical_cards_and_authoritative_state() {
        let clock = Rc::new(ManualClock::default());
        let (mut client, state) = fake_client_with_clock(vec![TransportEvent::Opened], clock);
        client.poll().unwrap();
        let absent_error = client.vote("5").unwrap_err();
        assert_eq!(absent_error.code, ClientErrorCode::NotReady);
        assert_error_code(client.retract_vote(), ClientErrorCode::NotReady);
        assert_error_code(client.restart(), ClientErrorCode::NotReady);
        assert_error_code(client.reveal(), ClientErrorCode::NotReady);
        client.rename("Alicia".to_string()).unwrap();
        client.chat("hello".to_string()).unwrap();

        let mut playing: serde_json::Value =
            serde_json::from_str(&room_payload("PLAYING", &[("Alice", "", true)], &[])).unwrap();
        playing["deck"] = serde_json::json!(["05", " Coffee ", "-", "?"]);
        client.apply_room_snapshot(snapshot(playing.to_string()));

        assert_error_code(client.vote(" 05 "), ClientErrorCode::InvalidCard);
        client.vote("05").unwrap();
        client.vote(" Coffee ").unwrap();
        client.vote("-").unwrap();
        client.vote("?").unwrap();
        client.retract_vote().unwrap();
        assert_eq!(client.vote, None);
        client.reveal().unwrap();
        assert_error_code(client.restart(), ClientErrorCode::InvalidState);

        assert_eq!(client.name, "Alice");
        assert_eq!(
            state.borrow().sent,
            [
                r#"{"requestType":"ChangeName","name":"Alicia"}"#,
                r#"{"requestType":"ChatMessage","message":"hello"}"#,
                r#"{"requestType":"PlayCard","cardValue":"05"}"#,
                r#"{"requestType":"PlayCard","cardValue":" Coffee "}"#,
                r#"{"requestType":"PlayCard","cardValue":"-"}"#,
                r#"{"requestType":"PlayCard","cardValue":"?"}"#,
                r#"{"requestType":"PlayCard","cardValue":null}"#,
                r#"{"requestType":"RevealCards"}"#,
            ]
        );

        let revision = client.revision();
        assert_error_code(client.vote("not-a-card"), ClientErrorCode::InvalidCard);
        assert_eq!(client.revision(), revision);
        assert!(client.log().is_empty());
    }

    #[test]
    fn phase_illegal_commands_are_typed_and_send_nothing() {
        for phase in ["CARDS_REVEALED", "FUTURE_PHASE"] {
            let (mut client, state) =
                open_client_with_phase(phase, Rc::new(ManualClock::default()));
            let revision = client.revision();

            assert_error_code(client.vote("5"), ClientErrorCode::InvalidState);
            assert_error_code(client.retract_vote(), ClientErrorCode::InvalidState);
            assert_eq!(client.revision(), revision);
            assert!(state.borrow().sent.is_empty());
        }

        for phase in ["PLAYING", "FUTURE_PHASE"] {
            let (mut client, state) =
                open_client_with_phase(phase, Rc::new(ManualClock::default()));
            let revision = client.revision();
            let room = client.room().cloned();
            let vote = client.own_vote().clone();

            assert_error_code(client.restart(), ClientErrorCode::InvalidState);
            assert_eq!(client.room(), room.as_ref());
            assert_eq!(client.own_vote(), &vote);
            assert_eq!(client.revision(), revision);
            assert!(state.borrow().sent.is_empty());
        }
    }

    #[test]
    fn revealed_commands_do_not_repeat_reveal_and_do_handoff_reset() {
        let clock = Rc::new(ManualClock::default());
        let (mut client, state) = open_client_with_phase("CARDS_REVEALED", clock);

        let revision = client.revision();
        client.reveal().unwrap();
        client.restart().unwrap();

        let state = state.borrow();
        assert_eq!(state.sent.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&state.sent[0]).unwrap()["requestType"],
            "StartNewRound"
        );
        assert_eq!(client.room().unwrap().phase, GamePhase::Revealed);
        assert_eq!(client.revision(), revision);
    }

    #[test]
    fn room_updates_deduplicate_server_logs_and_do_not_fabricate_initial_history() {
        let clock = Rc::new(ManualClock::default());
        let mut session = new_client(clock.clone());
        assert!(session.room().is_none());
        assert_eq!(session.round_number, 0);

        let playing = room_payload(
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[("INFO", "first")],
        );
        session.apply_room_snapshot(snapshot(playing));
        clock.advance(Duration::from_secs(4));
        session.apply_room_snapshot(room_snapshot(
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
            &[("INFO", "first"), ("CHAT", "second")],
        ));

        assert_eq!(session.log.len(), 2);
        assert_eq!(session.log[0].timestamp, Duration::ZERO);
        assert_eq!(session.log[1].timestamp, Duration::from_secs(4));
        assert_eq!(session.round_number, 1);
        assert!(session.history.is_empty());
    }

    #[test]
    fn room_snapshots_index_sparse_logs_before_cumulative_updates() {
        let clock = Rc::new(ManualClock::default());
        let payload = |appended: bool| {
            let mut logs = vec![
                serde_json::json!({ "level": "INFO", "message": "first" }),
                serde_json::json!({ "level": "FUTURE_LEVEL", "message": "unknown" }),
                serde_json::json!({ "level": "CHAT", "message": "third" }),
            ];
            if appended {
                logs.push(serde_json::json!({ "level": "ERROR", "message": "fourth" }));
            }
            serde_json::json!({
                "roomId": "log-room",
                "deck": [],
                "gamePhase": "PLAYING",
                "users": [],
                "average": "0",
                "log": logs,
            })
            .to_string()
        };

        let mut session = new_client(clock.clone());
        session.apply_room_snapshot(snapshot(payload(false)));
        assert_eq!(session.revision(), 1);
        assert_eq!(
            session
                .log()
                .iter()
                .map(|entry| (entry.server_index, entry.message.as_str(), entry.timestamp))
                .collect::<Vec<_>>(),
            [
                (Some(0), "first", Duration::ZERO),
                (Some(2), "third", Duration::ZERO),
            ]
        );

        clock.advance(Duration::from_secs(5));
        session.apply_room_snapshot(snapshot(payload(true)));
        assert_eq!(session.revision(), 2);
        session.apply_room_snapshot(snapshot(payload(true)));

        assert_eq!(
            session
                .log()
                .iter()
                .map(|entry| (entry.server_index, entry.message.as_str(), entry.timestamp))
                .collect::<Vec<_>>(),
            [
                (Some(0), "first", Duration::ZERO),
                (Some(2), "third", Duration::ZERO),
                (Some(3), "fourth", Duration::from_secs(5)),
            ]
        );
        assert_eq!(session.revision(), 2);
    }

    #[test]
    fn aggregate_snapshot_is_core_owned_and_uses_safe_milliseconds() {
        let clock = Rc::new(ManualClock::default());
        let mut session = new_client(clock.clone());
        session.apply_room_snapshot(room_snapshot(
            "PLAYING",
            &[("Alice", "5", true)],
            &[("INFO", "joined")],
        ));
        clock.advance(Duration::from_millis(2500));
        session.apply_room_snapshot(room_snapshot(
            "CARDS_REVEALED",
            &[("Alice", "5", true)],
            &[("INFO", "joined")],
        ));

        let aggregate = session.snapshot().unwrap();
        let room = aggregate.room.as_ref().unwrap();
        let local_player = &room.players[0];
        let log = &aggregate.log[0];
        let history = &aggregate.history[0];
        assert_eq!(aggregate.revision, 2);
        assert_eq!(aggregate.status, ConnectionStatus::Disconnected);
        assert_eq!(aggregate.terminal_error, None);
        assert_eq!(room.name, "test-room");
        assert_eq!(room.phase, GamePhase::Revealed);
        assert_eq!(room.deck, ["1", "3", "5", "?"]);
        assert_eq!(room.players.len(), 1);
        assert_eq!(local_player.name, "Alice");
        assert_eq!(local_player.vote, Vote::Revealed(VoteData::Number(5)));
        assert!(local_player.is_you);
        assert_eq!(local_player.user_type, UserType::Player);
        assert_eq!(aggregate.local_name, "Alice");
        assert_eq!(aggregate.local_vote, Some(VoteData::Number(5)));
        assert_eq!(aggregate.log.len(), 1);
        assert_eq!(log.timestamp, Duration::ZERO);
        assert_eq!(log.level, LogLevel::Info);
        assert_eq!(log.message, "joined");
        assert_eq!(log.source, LogSource::Server);
        assert_eq!(log.server_index, Some(0));
        assert_eq!(aggregate.round_number, 1);
        assert_eq!(aggregate.history.len(), 1);
        assert_eq!(history.round_number, 1);
        assert_eq!(history.average, Some(5.0));
        assert_eq!(history.votes.len(), 1);
        assert_eq!(history.deck, ["1", "3", "5", "?"]);
        assert_eq!(history.own_vote, Some(VoteData::Number(5)));
        assert_eq!(aggregate.average, Some(5.0));

        let value = serde_json::to_value(aggregate).unwrap();
        assert_eq!(value["revision"], 2);
        assert_eq!(value["status"], "disconnected");
        assert_eq!(value["terminalError"], serde_json::Value::Null);
        assert_eq!(value["room"]["name"], "test-room");
        assert_eq!(value["localName"], "Alice");
        assert_eq!(value["localVote"]["value"], 5);
        assert_eq!(value["log"][0]["timestampMs"], 0.0);
        assert_eq!(value["roundNumber"], 1);
        assert!(value.get("roundStartedAtMs").is_none());
        assert!(value["history"][0].get("lengthMs").is_none());
        assert_eq!(value["average"], 5.0);
    }

    #[test]
    fn aggregate_snapshot_rejects_unsafe_times_and_non_finite_averages_in_core() {
        let unsafe_duration = Duration::from_millis((crate::models::MAX_SAFE_INTEGER + 1) as u64);
        let mut session = new_client(Rc::new(ManualClock::default()));
        session.log.push(LogEntry {
            timestamp: unsafe_duration,
            level: LogLevel::Info,
            message: String::new(),
            source: LogSource::Client,
            server_index: None,
        });
        let error = session.snapshot().unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Protocol);
        assert_eq!(
            error.to_string(),
            "Client snapshot contains a time outside the JavaScript safe integer range."
        );

        session.log.clear();
        session.history.push(HistoryEntry {
            round_number: 1,
            average: Some(f32::NAN),
            votes: vec![],
            deck: vec![],
            own_vote: None,
        });
        assert_eq!(
            session.snapshot().unwrap_err().code,
            ClientErrorCode::Protocol
        );
    }

    #[test]
    fn authoritative_snapshot_samples_clock_once_before_mutation() {
        let clock = Rc::new(PanickingClock::new(2, Duration::from_secs(7)));
        let mut session = new_client(clock.clone());

        session.apply_room_snapshot(room_snapshot(
            "PLAYING",
            &[("Alice", "", true)],
            &[("INFO", "first"), ("CHAT", "second")],
        ));

        assert_eq!(clock.calls.get(), 1);
        assert_eq!(session.revision(), 1);
        assert_eq!(session.room().unwrap().phase, GamePhase::Playing);
        assert_eq!(session.log().len(), 2);
        assert!(session
            .log()
            .iter()
            .all(|entry| entry.timestamp == Duration::from_secs(7)));
    }

    #[test]
    fn first_clock_sample_panic_leaves_session_unchanged() {
        let clock = Rc::new(PanickingClock::new(1, Duration::from_secs(7)));
        let mut session = new_client(clock.clone());
        let update = room_snapshot("PLAYING", &[("Alice", "", true)], &[("INFO", "first")]);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.apply_room_snapshot(update);
        }));

        assert!(result.is_err());
        assert_eq!(clock.calls.get(), 1);
        assert_eq!(session.revision(), 0);
        assert!(session.room().is_none());
        assert_eq!(session.round_number(), 0);
        assert!(session.log().is_empty());
        assert!(session.history().is_empty());
    }

    #[test]
    fn phase_transitions_record_optional_average_and_increment_rounds() {
        let mut session = new_client(Rc::new(ManualClock::default()));
        apply_votes(
            &mut session,
            "PLAYING",
            &[("Alice", "3", true), ("Bob", "5", false)],
        );
        assert_eq!(session.average_votes(), None);
        apply_votes(
            &mut session,
            "CARDS_REVEALED",
            &[("Alice", "3", true), ("Bob", "5", false)],
        );

        assert_eq!(session.average_votes(), Some(4.0));
        assert_eq!(session.history.len(), 1);
        assert_eq!(session.history[0].average, Some(4.0));

        apply_votes(
            &mut session,
            "PLAYING",
            &[("Alice", "", true), ("Bob", "", false)],
        );
        assert_eq!(session.round_number, 2);
    }

    #[test]
    fn absent_numeric_votes_have_no_non_finite_average() {
        let clock = Rc::new(ManualClock::default());
        let mut session = new_client(clock);
        apply_votes(&mut session, "PLAYING", &[("Alice", "?", true)]);
        apply_votes(&mut session, "CARDS_REVEALED", &[("Alice", "?", true)]);

        assert_eq!(session.average_votes(), None);
        assert_eq!(session.history[0].average, None);
    }

    #[test]
    fn snapshots_reconcile_local_identity_vote_and_history_before_phase_effects() {
        let clock = Rc::new(ManualClock::default());
        let mut session = Client::new("Configured name".to_string(), clock.clone());
        apply_votes(
            &mut session,
            "PLAYING",
            &[("Bob", "✅", false), ("Alice", "3", true)],
        );
        assert_eq!(session.name(), "Alice");
        assert_eq!(session.own_vote(), &Some(VoteData::Number(3)));
        clock.advance(Duration::from_secs(1));
        apply_votes(
            &mut session,
            "CARDS_REVEALED",
            &[("Bob", "5", false), ("Alicia", "?", true)],
        );

        assert_eq!(
            session.history[0]
                .votes
                .iter()
                .map(|player: &Player| player.name.as_str())
                .collect::<Vec<_>>(),
            ["Bob", "Alicia"]
        );
        assert_eq!(session.name(), "Alicia");
        assert_eq!(
            session.own_vote(),
            &Some(VoteData::Special("?".to_string()))
        );
        assert_eq!(
            session.history[0].own_vote,
            Some(VoteData::Special("?".to_string()))
        );
        assert!(session
            .room()
            .unwrap()
            .players
            .iter()
            .all(|player| player.user_type == UserType::Player));

        apply_votes(&mut session, "PLAYING", &[("Alicia", "✅", true)]);
        assert_eq!(session.own_vote(), &None);
    }

    #[test]
    fn snapshot_without_local_player_clears_vote_before_recording_history() {
        let clock = Rc::new(ManualClock::default());
        let mut session = new_client(clock.clone());
        apply_votes(
            &mut session,
            "PLAYING",
            &[("Alice", "5", true), ("Bob", "✅", false)],
        );
        assert_eq!(session.name(), "Alice");
        assert_eq!(session.own_vote(), &Some(VoteData::Number(5)));

        clock.advance(Duration::from_secs(1));
        apply_votes(&mut session, "CARDS_REVEALED", &[("Bob", "3", false)]);

        assert_eq!(session.name(), "Alice");
        assert_eq!(session.own_vote(), &None);
        assert_eq!(session.history().len(), 1);
        assert_eq!(session.history()[0].own_vote, None);
    }
}
