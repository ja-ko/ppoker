use std::cell::RefCell;
use std::rc::{Rc, Weak};
#[cfg(target_arch = "wasm32")]
use std::time::Duration;

#[cfg(target_arch = "wasm32")]
use js_sys::Function;
use js_sys::{Error as JsError, Reflect};
#[cfg(any(test, target_arch = "wasm32"))]
use ppoker_core::client::Clock;
use ppoker_core::client::{
    Client, ClientError, ClientErrorCode, ConnectionStatus, Transport, TransportEvent,
};
#[cfg(any(test, target_arch = "wasm32"))]
use ppoker_core::protocol::build_room_url;
use ppoker_core::protocol::ConnectionRole;
use serde::{Deserialize, Serialize};
use tsify::Tsify;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
mod transport;

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

#[cfg(any(test, target_arch = "wasm32"))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct InvalidOptionsError {
    message: String,
    details: InvalidOptionsDetails,
}

#[cfg(any(test, target_arch = "wasm32"))]
impl InvalidOptionsError {
    fn new(message: impl Into<String>, field: &str, reason: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            details: InvalidOptionsDetails {
                field: field.to_string(),
                reason: reason.into(),
            },
        }
    }
}

type EventSink = Rc<dyn Fn(TransportEvent)>;
type ChangeNotifier = Rc<dyn Fn()>;
type TransportFactory = Box<dyn FnMut(&str, EventSink) -> Result<Box<dyn Transport>, String>>;

#[cfg(target_arch = "wasm32")]
struct BrowserClock {
    performance: web_sys::Performance,
}

#[cfg(target_arch = "wasm32")]
impl BrowserClock {
    fn new() -> Result<Self, ClientError> {
        let performance = web_sys::window()
            .and_then(|window| window.performance())
            .ok_or_else(|| ClientError {
                code: ClientErrorCode::Protocol,
                message: "Browser monotonic clock is unavailable.".to_string(),
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

#[wasm_bindgen]
pub struct WasmPokerClient {
    room_url: String,
    client: Rc<RefCell<Client>>,
    transport_factory: TransportFactory,
}

#[cfg(any(test, target_arch = "wasm32"))]
impl WasmPokerClient {
    fn from_options(
        options: ClientOptions,
        clock: Rc<dyn Clock>,
        transport_factory: TransportFactory,
    ) -> Result<Self, InvalidOptionsError> {
        let room_url = build_room_url(
            &options.endpoint,
            &options.room,
            &options.name,
            options.role,
        )
        .map_err(|error| {
            let field = error.field();
            InvalidOptionsError::new(error.to_string(), field, error.to_string())
        })?;

        Ok(Self {
            room_url,
            client: Rc::new(RefCell::new(Client::new(options.name, clock))),
            transport_factory,
        })
    }
}

impl WasmPokerClient {
    fn connect_with_notifier(&mut self, notifier: ChangeNotifier) -> Result<(), JsValue> {
        match self.client.borrow().status() {
            ConnectionStatus::Connecting | ConnectionStatus::Open => return Ok(()),
            ConnectionStatus::Closed => {
                return Err(client_error_to_js(ClientError::closed("Client is closed.")))
            }
            ConnectionStatus::Disconnected => {}
        }

        let events = event_sink(Rc::downgrade(&self.client), notifier);
        let transport = match (self.transport_factory)(&self.room_url, events) {
            Ok(transport) => transport,
            Err(_reason) => {
                let error = self
                    .client
                    .borrow_mut()
                    .fail_transport("WebSocket connection could not be created.");
                return Err(client_error_to_js(error));
            }
        };
        self.client
            .borrow_mut()
            .connect(transport)
            .map(|_| ())
            .map_err(client_error_to_js)
    }
}

fn event_sink(client: Weak<RefCell<Client>>, notifier: ChangeNotifier) -> EventSink {
    Rc::new(move |event| {
        let Some(client) = client.upgrade() else {
            return;
        };
        let changed = {
            let mut client = client.borrow_mut();
            let revision = client.revision();
            let _ = client.handle_transport_event(event);
            client.revision() != revision
        };
        if changed {
            notifier();
        }
    })
}

#[cfg(target_arch = "wasm32")]
fn parse_options(value: JsValue) -> Result<ClientOptions, InvalidOptionsError> {
    serde_wasm_bindgen::from_value(value).map_err(|error| {
        InvalidOptionsError::new("Client options are invalid.", "options", error.to_string())
    })
}

fn serialize_js(value: &impl Serialize) -> Result<JsValue, ClientError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|error| ClientError {
            code: ClientErrorCode::Protocol,
            message: format!("Client snapshot could not be converted: {error}"),
        })
}

fn client_error_to_js(error: ClientError) -> JsValue {
    let code = serde_wasm_bindgen::to_value(&error.code)
        .expect("client error codes serialize to JavaScript strings");
    error_to_js(&error.message, &code, None)
}

#[cfg(target_arch = "wasm32")]
fn invalid_options_to_js(error: InvalidOptionsError) -> JsValue {
    let details = serde_wasm_bindgen::to_value(&error.details)
        .expect("invalid option details serialize to JavaScript objects");
    error_to_js(
        &error.message,
        &JsValue::from_str("InvalidOptions"),
        Some(&details),
    )
}

fn error_to_js(message: &str, code: &JsValue, details: Option<&JsValue>) -> JsValue {
    let js_error = JsError::new(message);
    let _ = Reflect::set(&js_error, &JsValue::from_str("code"), code);
    if let Some(details) = details {
        let _ = Reflect::set(&js_error, &JsValue::from_str("details"), details);
    }
    js_error.into()
}

#[wasm_bindgen]
impl WasmPokerClient {
    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(unchecked_param_type = "ClientOptions")] options: JsValue,
    ) -> Result<WasmPokerClient, JsValue> {
        let options = parse_options(options).map_err(invalid_options_to_js)?;
        let clock = Rc::new(BrowserClock::new().map_err(client_error_to_js)?);
        Self::from_options(
            options,
            clock,
            Box::new(|url, events| {
                transport::BrowserTransport::connect(url, events)
                    .map(|transport| Box::new(transport) as Box<dyn Transport>)
            }),
        )
        .map_err(invalid_options_to_js)
    }

    #[cfg(target_arch = "wasm32")]
    pub fn connect(
        &mut self,
        #[wasm_bindgen(unchecked_param_type = "() => void")] on_change: Function,
    ) -> Result<(), JsValue> {
        self.connect_with_notifier(Rc::new(move || {
            let _ = on_change.call0(&JsValue::UNDEFINED);
        }))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn connect(&mut self) -> Result<(), JsValue> {
        self.connect_with_notifier(Rc::new(|| {}))
    }

    #[wasm_bindgen(unchecked_return_type = "ClientSnapshot")]
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .client
            .borrow()
            .snapshot()
            .map_err(client_error_to_js)?;
        serialize_js(&snapshot).map_err(client_error_to_js)
    }

    pub fn vote(&mut self, value: &str) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .vote(value)
            .map_err(client_error_to_js)
    }

    #[wasm_bindgen(js_name = retractVote)]
    pub fn retract_vote(&mut self) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .retract_vote()
            .map_err(client_error_to_js)
    }

    pub fn rename(&mut self, name: String) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .rename(name)
            .map_err(client_error_to_js)
    }

    pub fn chat(&mut self, message: String) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .chat(message)
            .map_err(client_error_to_js)
    }

    pub fn reveal(&mut self) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .reveal()
            .map_err(client_error_to_js)
    }

    #[wasm_bindgen(js_name = startNewRound)]
    pub fn start_new_round(&mut self) -> Result<(), JsValue> {
        self.client
            .borrow_mut()
            .restart()
            .map_err(client_error_to_js)
    }

    pub fn close(&mut self) {
        self.client.borrow_mut().close();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[cfg(all(test, target_arch = "wasm32"))]
mod web_tests;
