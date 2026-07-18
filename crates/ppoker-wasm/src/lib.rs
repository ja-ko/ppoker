use std::rc::Rc;
use std::time::Duration;

use js_sys::{Error as JsError, Reflect};
use ppoker_core::client::{
    ClientError, ClientErrorCode, Clock, ConnectionStatus, PokerClient, Session, Transport,
    WebPokerClient,
};
use ppoker_core::models::{
    GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};
use ppoker_core::protocol::{build_room_url, ConnectionRole};
use serde::{Deserialize, Serialize};
use tsify::Tsify;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
mod transport;
#[cfg(any(test, target_arch = "wasm32"))]
mod transport_queue;

const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum ClientRole {
    Participant,
    Spectator,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientOptions {
    pub endpoint: String,
    pub room: String,
    pub name: String,
    pub role: ClientRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotStatus {
    Disconnected,
    Connecting,
    Open,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
pub enum ErrorCode {
    InvalidOptions,
    NotReady,
    Closed,
    Transport,
    Protocol,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetails {
    pub field: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct ClientErrorSnapshot {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<ErrorDetails>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum PlayerRole {
    Participant,
    Spectator,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum PhaseSnapshot {
    Playing,
    Revealed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoteValueSnapshot {
    Number { value: u8 },
    Special { value: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum VoteSnapshot {
    Missing,
    Hidden,
    Revealed { value: VoteValueSnapshot },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub name: String,
    pub vote: VoteSnapshot,
    pub is_you: bool,
    pub role: PlayerRole,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub name: String,
    pub deck: Vec<String>,
    pub phase: PhaseSnapshot,
    pub players: Vec<PlayerSnapshot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum ActivityLevel {
    Chat,
    Info,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum ActivitySource {
    Server,
    Client,
}

#[derive(Clone, Debug, PartialEq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct ActivitySnapshot {
    pub timestamp_ms: f64,
    pub level: ActivityLevel,
    pub message: String,
    pub source: ActivitySource,
    pub server_index: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct CurrentRoundSnapshot {
    pub number: u32,
    pub started_at_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct HistorySnapshot {
    pub round_number: u32,
    pub average: Option<f32>,
    pub duration_ms: f64,
    pub votes: Vec<PlayerSnapshot>,
    pub deck: Vec<String>,
    pub local_vote: Option<VoteValueSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct StatisticsSnapshot {
    pub average: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct ClientSnapshot {
    pub revision: u32,
    pub status: SnapshotStatus,
    pub terminal_error: Option<ClientErrorSnapshot>,
    pub room: Option<RoomSnapshot>,
    pub local_name: String,
    pub local_vote: Option<VoteValueSnapshot>,
    pub activity: Vec<ActivitySnapshot>,
    pub current_round: CurrentRoundSnapshot,
    pub history: Vec<HistorySnapshot>,
    pub statistics: StatisticsSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FacadeError {
    code: ErrorCode,
    message: String,
    details: Option<ErrorDetails>,
}

impl FacadeError {
    fn invalid_options(message: impl Into<String>, field: &str, reason: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::InvalidOptions,
            message: message.into(),
            details: Some(ErrorDetails {
                field: field.to_string(),
                reason: reason.into(),
            }),
        }
    }

    fn transport(message: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Transport,
            message: message.into(),
            details: Some(ErrorDetails {
                field: "transport".to_string(),
                reason: reason.into(),
            }),
        }
    }

    fn protocol(message: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Protocol,
            message: message.into(),
            details: Some(ErrorDetails {
                field: "snapshot".to_string(),
                reason: reason.into(),
            }),
        }
    }

    fn closed() -> Self {
        Self {
            code: ErrorCode::Closed,
            message: "Client is closed.".to_string(),
            details: None,
        }
    }
}

impl From<ClientError> for FacadeError {
    fn from(error: ClientError) -> Self {
        Self {
            code: error.code.into(),
            message: error.message,
            details: None,
        }
    }
}

impl From<ClientErrorCode> for ErrorCode {
    fn from(code: ClientErrorCode) -> Self {
        match code {
            ClientErrorCode::NotReady => Self::NotReady,
            ClientErrorCode::Closed => Self::Closed,
            ClientErrorCode::Transport => Self::Transport,
            ClientErrorCode::Protocol => Self::Protocol,
        }
    }
}

impl From<ConnectionStatus> for SnapshotStatus {
    fn from(status: ConnectionStatus) -> Self {
        match status {
            ConnectionStatus::Disconnected => Self::Disconnected,
            ConnectionStatus::Connecting => Self::Connecting,
            ConnectionStatus::Open => Self::Open,
            ConnectionStatus::Closed => Self::Closed,
        }
    }
}

impl From<ClientRole> for ConnectionRole {
    fn from(role: ClientRole) -> Self {
        match role {
            ClientRole::Participant => Self::Participant,
            ClientRole::Spectator => Self::Spectator,
        }
    }
}

trait TransportFactory {
    fn create(&mut self, url: &str) -> Result<Box<dyn Transport>, String>;
}

struct BrowserTransportFactory;

#[cfg(target_arch = "wasm32")]
impl TransportFactory for BrowserTransportFactory {
    fn create(&mut self, url: &str) -> Result<Box<dyn Transport>, String> {
        transport::BrowserTransport::connect(url)
            .map(|transport| Box::new(transport) as Box<dyn Transport>)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl TransportFactory for BrowserTransportFactory {
    fn create(&mut self, _url: &str) -> Result<Box<dyn Transport>, String> {
        Err("Browser WebSocket transport requires wasm32.".to_string())
    }
}

#[cfg(target_arch = "wasm32")]
struct BrowserClock {
    performance: web_sys::Performance,
}

#[cfg(target_arch = "wasm32")]
impl BrowserClock {
    fn new() -> Result<Self, FacadeError> {
        let performance = web_sys::window()
            .and_then(|window| window.performance())
            .ok_or_else(|| {
                FacadeError::protocol(
                    "Browser monotonic clock is unavailable.",
                    "window.performance is unavailable",
                )
            })?;
        Ok(Self { performance })
    }
}

#[cfg(target_arch = "wasm32")]
impl Clock for BrowserClock {
    fn now(&self) -> Duration {
        let now_ms = self.performance.now();
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Duration::MAX;
        }
        Duration::from_millis(now_ms.floor() as u64)
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct NativeClock(std::time::Instant);

#[cfg(not(target_arch = "wasm32"))]
impl NativeClock {
    fn new() -> Self {
        Self(std::time::Instant::now())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Clock for NativeClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

fn production_clock() -> Result<Rc<dyn Clock>, FacadeError> {
    #[cfg(target_arch = "wasm32")]
    {
        Ok(Rc::new(BrowserClock::new()?))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Ok(Rc::new(NativeClock::new()))
    }
}

#[derive(PartialEq)]
struct VisibleState {
    status: ConnectionStatus,
    terminal_error: Option<ClientError>,
    session_revision: u32,
}

struct ClientFacade {
    room_url: String,
    client: WebPokerClient,
    session: Session,
    revision: u32,
    transport_factory: Box<dyn TransportFactory>,
}

impl ClientFacade {
    fn new(
        options: ClientOptions,
        clock: Rc<dyn Clock>,
        transport_factory: Box<dyn TransportFactory>,
    ) -> Result<Self, FacadeError> {
        let room_url = build_room_url(
            &options.endpoint,
            &options.room,
            &options.name,
            options.role.into(),
        )
        .map_err(|error| {
            let field = error.field();
            FacadeError::invalid_options(error.to_string(), field, error.to_string())
        })?;

        Ok(Self {
            room_url,
            client: WebPokerClient::new(),
            session: Session::new(options.name, clock),
            revision: 0,
            transport_factory,
        })
    }

    fn connect(&mut self) -> Result<(), FacadeError> {
        match self.client.status() {
            ConnectionStatus::Connecting | ConnectionStatus::Open => return Ok(()),
            ConnectionStatus::Closed => return Err(FacadeError::closed()),
            ConnectionStatus::Disconnected => {}
        }

        let before = self.visible_state();
        let transport = match self.transport_factory.create(&self.room_url) {
            Ok(transport) => transport,
            Err(reason) => {
                self.client
                    .fail_transport("WebSocket connection could not be created.");
                self.commit_if_changed(before);
                return Err(FacadeError::transport(
                    "WebSocket connection could not be created.",
                    reason,
                ));
            }
        };
        self.client.connect(transport).map_err(FacadeError::from)?;
        self.commit_if_changed(before);
        Ok(())
    }

    fn poll(&mut self) -> bool {
        if self.client.status() == ConnectionStatus::Closed {
            return false;
        }

        let before = self.visible_state();
        let snapshots = self.client.get_updates().unwrap_or_default();
        self.session.apply_poll_batch(snapshots, |_, _| {});
        self.commit_if_changed(before)
    }

    fn vote(&mut self, value: &str) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.vote(value, client))
    }

    fn retract_vote(&mut self) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.vote("-", client))
    }

    fn rename(&mut self, name: String) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.rename(name, client))
    }

    fn chat(&mut self, message: String) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.chat(message, client))
    }

    fn reveal(&mut self) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.reveal(client))
    }

    fn start_new_round(&mut self) -> Result<(), FacadeError> {
        self.dispatch(|session, client| session.restart(client))
    }

    fn dispatch(
        &mut self,
        operation: impl FnOnce(&mut Session, &mut WebPokerClient) -> Result<(), ClientError>,
    ) -> Result<(), FacadeError> {
        let before = self.visible_state();
        let result = operation(&mut self.session, &mut self.client);
        self.commit_if_changed(before);
        result.map_err(FacadeError::from)
    }

    fn close(&mut self) {
        if self.client.status() == ConnectionStatus::Closed {
            return;
        }
        let before = self.visible_state();
        self.client.close();
        self.commit_if_changed(before);
    }

    fn snapshot(&self) -> Result<ClientSnapshot, FacadeError> {
        Ok(ClientSnapshot {
            revision: self.revision,
            status: self.client.status().into(),
            terminal_error: self
                .client
                .terminal_error()
                .cloned()
                .map(client_error_snapshot),
            room: self.session.room().map(room_snapshot),
            local_name: self.session.name().to_string(),
            local_vote: self.session.own_vote().as_ref().map(vote_value_snapshot),
            activity: self
                .session
                .log()
                .iter()
                .map(activity_snapshot)
                .collect::<Result<_, _>>()?,
            current_round: CurrentRoundSnapshot {
                number: self.session.round_number(),
                started_at_ms: self.session.round_start().map(duration_ms).transpose()?,
            },
            history: self
                .session
                .history()
                .iter()
                .map(history_snapshot)
                .collect::<Result<_, _>>()?,
            statistics: StatisticsSnapshot {
                average: finite_average(self.session.average_votes())?,
            },
        })
    }

    fn visible_state(&self) -> VisibleState {
        VisibleState {
            status: self.client.status(),
            terminal_error: self.client.terminal_error().cloned(),
            session_revision: self.session.revision(),
        }
    }

    fn commit_if_changed(&mut self, before: VisibleState) -> bool {
        if before == self.visible_state() {
            false
        } else {
            self.revision = self.revision.saturating_add(1);
            true
        }
    }
}

fn client_error_snapshot(error: ClientError) -> ClientErrorSnapshot {
    ClientErrorSnapshot {
        code: error.code.into(),
        message: error.message,
        details: None,
    }
}

fn room_snapshot(room: &Room) -> RoomSnapshot {
    RoomSnapshot {
        name: room.name.clone(),
        deck: room.deck.clone(),
        phase: match room.phase {
            GamePhase::Playing => PhaseSnapshot::Playing,
            GamePhase::Revealed => PhaseSnapshot::Revealed,
            GamePhase::Unknown => PhaseSnapshot::Unknown,
        },
        players: room.players.iter().map(player_snapshot).collect(),
    }
}

fn player_snapshot(player: &Player) -> PlayerSnapshot {
    PlayerSnapshot {
        name: player.name.clone(),
        vote: match &player.vote {
            Vote::Missing => VoteSnapshot::Missing,
            Vote::Hidden => VoteSnapshot::Hidden,
            Vote::Revealed(value) => VoteSnapshot::Revealed {
                value: vote_value_snapshot(value),
            },
        },
        is_you: player.is_you,
        role: match player.user_type {
            UserType::Player => PlayerRole::Participant,
            UserType::Spectator => PlayerRole::Spectator,
            UserType::Unknown => PlayerRole::Unknown,
        },
    }
}

fn vote_value_snapshot(vote: &VoteData) -> VoteValueSnapshot {
    match vote {
        VoteData::Number(value) => VoteValueSnapshot::Number { value: *value },
        VoteData::Special(value) => VoteValueSnapshot::Special {
            value: value.clone(),
        },
    }
}

fn activity_snapshot(entry: &LogEntry) -> Result<ActivitySnapshot, FacadeError> {
    Ok(ActivitySnapshot {
        timestamp_ms: duration_ms(entry.timestamp)?,
        level: match entry.level {
            LogLevel::Chat => ActivityLevel::Chat,
            LogLevel::Info => ActivityLevel::Info,
            LogLevel::Error => ActivityLevel::Error,
        },
        message: entry.message.clone(),
        source: match entry.source {
            LogSource::Server => ActivitySource::Server,
            LogSource::Client => ActivitySource::Client,
        },
        server_index: entry.server_index,
    })
}

fn history_snapshot(entry: &HistoryEntry) -> Result<HistorySnapshot, FacadeError> {
    Ok(HistorySnapshot {
        round_number: entry.round_number,
        average: finite_average(entry.average)?,
        duration_ms: duration_ms(entry.length)?,
        votes: entry.votes.iter().map(player_snapshot).collect(),
        deck: entry.deck.clone(),
        local_vote: entry.own_vote.as_ref().map(vote_value_snapshot),
    })
}

fn finite_average(average: Option<f32>) -> Result<Option<f32>, FacadeError> {
    match average {
        Some(value) if !value.is_finite() => Err(FacadeError::protocol(
            "Client snapshot contains an invalid average.",
            "average must be finite",
        )),
        average => Ok(average),
    }
}

fn duration_ms(duration: Duration) -> Result<f64, FacadeError> {
    let milliseconds = duration.as_millis();
    if milliseconds > MAX_SAFE_INTEGER {
        return Err(FacadeError::protocol(
            "Client snapshot contains a time outside the JavaScript safe integer range.",
            format!("{milliseconds} milliseconds"),
        ));
    }
    Ok(milliseconds as f64)
}

fn parse_options(value: JsValue) -> Result<ClientOptions, FacadeError> {
    serde_wasm_bindgen::from_value(value).map_err(|error| {
        FacadeError::invalid_options("Client options are invalid.", "options", error.to_string())
    })
}

fn serialize_js(value: &impl Serialize) -> Result<JsValue, FacadeError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| {
            FacadeError::protocol("Client snapshot could not be converted.", error.to_string())
        })
}

fn error_to_js(error: FacadeError) -> JsValue {
    let js_error = JsError::new(&error.message);
    let _ = Reflect::set(
        &js_error,
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code.as_str()),
    );
    if let Some(details) = error.details {
        if let Ok(details) = serde_wasm_bindgen::to_value(&details) {
            let _ = Reflect::set(&js_error, &JsValue::from_str("details"), &details);
        }
    }
    js_error.into()
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidOptions => "InvalidOptions",
            Self::NotReady => "NotReady",
            Self::Closed => "Closed",
            Self::Transport => "Transport",
            Self::Protocol => "Protocol",
        }
    }
}

#[wasm_bindgen]
pub struct WasmPokerClient {
    facade: ClientFacade,
}

#[wasm_bindgen]
impl WasmPokerClient {
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(unchecked_param_type = "ClientOptions")] options: JsValue,
    ) -> Result<WasmPokerClient, JsValue> {
        let options = parse_options(options).map_err(error_to_js)?;
        let clock = production_clock().map_err(error_to_js)?;
        let facade = ClientFacade::new(options, clock, Box::new(BrowserTransportFactory))
            .map_err(error_to_js)?;
        Ok(Self { facade })
    }

    pub fn connect(&mut self) -> Result<(), JsValue> {
        self.facade.connect().map_err(error_to_js)
    }

    pub fn poll(&mut self) -> bool {
        self.facade.poll()
    }

    #[wasm_bindgen(unchecked_return_type = "ClientSnapshot")]
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let snapshot = self.facade.snapshot().map_err(error_to_js)?;
        serialize_js(&snapshot).map_err(error_to_js)
    }

    pub fn vote(&mut self, value: &str) -> Result<(), JsValue> {
        self.facade.vote(value).map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = retractVote)]
    pub fn retract_vote(&mut self) -> Result<(), JsValue> {
        self.facade.retract_vote().map_err(error_to_js)
    }

    pub fn rename(&mut self, name: String) -> Result<(), JsValue> {
        self.facade.rename(name).map_err(error_to_js)
    }

    pub fn chat(&mut self, message: String) -> Result<(), JsValue> {
        self.facade.chat(message).map_err(error_to_js)
    }

    pub fn reveal(&mut self) -> Result<(), JsValue> {
        self.facade.reveal().map_err(error_to_js)
    }

    #[wasm_bindgen(js_name = startNewRound)]
    pub fn start_new_round(&mut self) -> Result<(), JsValue> {
        self.facade.start_new_round().map_err(error_to_js)
    }

    pub fn close(&mut self) {
        self.facade.close();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[cfg(all(test, target_arch = "wasm32"))]
mod web_tests;
