use std::rc::Rc;
use std::time::Duration;

use js_sys::{Error as JsError, Reflect};
use ppoker_core::client::{
    ClientError, ClientErrorCode, ClientSnapshot, Clock, ConnectionStatus, Session, Transport,
    WebPokerClient,
};
use ppoker_core::protocol::{build_room_url, ConnectionRole};
use serde::{Deserialize, Serialize};
use tsify::Tsify;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
mod transport;
#[cfg(any(test, target_arch = "wasm32"))]
mod transport_queue;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientOptions {
    pub endpoint: String,
    pub room: String,
    pub name: String,
    pub role: ConnectionRole,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct InvalidOptionsDetails {
    pub field: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FacadeErrorCode {
    InvalidOptions,
    Core(ClientErrorCode),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FacadeError {
    code: FacadeErrorCode,
    message: String,
    details: Option<InvalidOptionsDetails>,
}

impl FacadeError {
    fn invalid_options(message: impl Into<String>, field: &str, reason: impl Into<String>) -> Self {
        Self {
            code: FacadeErrorCode::InvalidOptions,
            message: message.into(),
            details: Some(InvalidOptionsDetails {
                field: field.to_string(),
                reason: reason.into(),
            }),
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: FacadeErrorCode::Core(ClientErrorCode::Transport),
            message: message.into(),
            details: None,
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: FacadeErrorCode::Core(ClientErrorCode::Protocol),
            message: message.into(),
            details: None,
        }
    }

    fn closed() -> Self {
        Self {
            code: FacadeErrorCode::Core(ClientErrorCode::Closed),
            message: "Client is closed.".to_string(),
            details: None,
        }
    }
}

impl From<ClientError> for FacadeError {
    fn from(error: ClientError) -> Self {
        Self {
            code: FacadeErrorCode::Core(error.code),
            message: error.message,
            details: None,
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
            .ok_or_else(|| FacadeError::protocol("Browser monotonic clock is unavailable."))?;
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

struct ClientFacade {
    room_url: String,
    session: Session<WebPokerClient>,
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
            options.role,
        )
        .map_err(|error| {
            let field = error.field();
            FacadeError::invalid_options(error.to_string(), field, error.to_string())
        })?;

        Ok(Self {
            room_url,
            session: Session::new(WebPokerClient::new(), options.name, clock),
            transport_factory,
        })
    }

    fn connect(&mut self) -> Result<(), FacadeError> {
        match self.session.status() {
            ConnectionStatus::Connecting | ConnectionStatus::Open => return Ok(()),
            ConnectionStatus::Closed => return Err(FacadeError::closed()),
            ConnectionStatus::Disconnected => {}
        }

        let transport = match self.transport_factory.create(&self.room_url) {
            Ok(transport) => transport,
            Err(_reason) => {
                self.session
                    .fail_transport("WebSocket connection could not be created.");
                return Err(FacadeError::transport(
                    "WebSocket connection could not be created.",
                ));
            }
        };
        self.session.connect(transport).map_err(FacadeError::from)?;
        Ok(())
    }

    fn poll(&mut self) -> bool {
        if self.session.status() == ConnectionStatus::Closed {
            return false;
        }

        let revision = self.session.revision();
        match self.session.update() {
            Ok(changed) => changed,
            Err(_) => self.session.revision() != revision,
        }
    }

    fn vote(&mut self, value: &str) -> Result<(), FacadeError> {
        self.session.vote(value).map_err(FacadeError::from)
    }

    fn retract_vote(&mut self) -> Result<(), FacadeError> {
        self.session.retract_vote().map_err(FacadeError::from)
    }

    fn rename(&mut self, name: String) -> Result<(), FacadeError> {
        self.session.rename(name).map_err(FacadeError::from)
    }

    fn chat(&mut self, message: String) -> Result<(), FacadeError> {
        self.session.chat(message).map_err(FacadeError::from)
    }

    fn reveal(&mut self) -> Result<(), FacadeError> {
        self.session.reveal().map_err(FacadeError::from)
    }

    fn start_new_round(&mut self) -> Result<(), FacadeError> {
        self.session.restart().map_err(FacadeError::from)
    }

    fn close(&mut self) {
        self.session.close();
    }

    fn snapshot(&self) -> Result<ClientSnapshot, FacadeError> {
        self.session.snapshot().map_err(FacadeError::from)
    }
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
            FacadeError::protocol(format!("Client snapshot could not be converted: {error}"))
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

impl FacadeErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidOptions => "InvalidOptions",
            Self::Core(ClientErrorCode::NotReady) => "NotReady",
            Self::Core(ClientErrorCode::InvalidCard) => "InvalidCard",
            Self::Core(ClientErrorCode::InvalidState) => "InvalidState",
            Self::Core(ClientErrorCode::Closed) => "Closed",
            Self::Core(ClientErrorCode::Transport) => "Transport",
            Self::Core(ClientErrorCode::Protocol) => "Protocol",
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
