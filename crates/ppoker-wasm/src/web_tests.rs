use std::cell::{Cell, RefCell};
use std::rc::Rc;

use js_sys::{Array, Function, Object, Promise, Reflect};
use ppoker_core::client::{Transport, TransportEvent};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;

use super::*;
use crate::transport::{MAX_TEXT_MESSAGE_BYTES, MESSAGE_TOO_LARGE_ERROR};

wasm_bindgen_test_configure!(run_in_browser);

struct FakeWebSocketGuard;

impl FakeWebSocketGuard {
    fn install() -> Self {
        js_sys::eval(
            r#"
            globalThis.__ppokerOriginalWebSocket = globalThis.WebSocket;
            globalThis.__ppokerSockets = [];
            globalThis.WebSocket = class {
                constructor(url) {
                    this.url = new URL(url).href;
                    this.binaryType = "blob";
                    this.readyState = 0;
                    this.sent = [];
                    this.closeCount = 0;
                    this.onopen = null;
                    this.onmessage = null;
                    this.onerror = null;
                    this.onclose = null;
                    globalThis.__ppokerSockets.push(this);
                }
                send(message) {
                    if (this.readyState !== 1) throw new DOMException("Socket is not open", "InvalidStateError");
                    this.sent.push(message);
                }
                close() {
                    this.closeCount += 1;
                    this.readyState = 3;
                }
            };
            "#,
        )
        .expect("fake WebSocket should install");
        Self
    }
}

impl Drop for FakeWebSocketGuard {
    fn drop(&mut self) {
        let _ = js_sys::eval(
            r#"
            globalThis.WebSocket = globalThis.__ppokerOriginalWebSocket;
            delete globalThis.__ppokerOriginalWebSocket;
            delete globalThis.__ppokerSockets;
            "#,
        );
    }
}

fn options(role: ConnectionRole) -> ClientOptions {
    ClientOptions {
        endpoint: "wss://example.test/base/".to_string(),
        room: "typed room".to_string(),
        name: "Browser user".to_string(),
        role,
    }
}

fn construct(options: ClientOptions) -> WasmPokerClient {
    WasmPokerClient::new(serde_wasm_bindgen::to_value(&options).unwrap()).unwrap()
}

fn noop() -> Function {
    Function::new_no_args("")
}

fn connect(client: &mut WasmPokerClient) {
    client.connect(noop()).unwrap();
}

fn property(value: &JsValue, name: &str) -> JsValue {
    Reflect::get(value, &JsValue::from_str(name)).unwrap()
}

fn set_property(value: &JsValue, name: &str, property_value: &JsValue) {
    Reflect::set(value, &JsValue::from_str(name), property_value).unwrap();
}

fn assert_string(value: &JsValue, name: &str, expected: &str) {
    assert_eq!(property(value, name).as_string().as_deref(), Some(expected));
}

fn assert_number(value: &JsValue, name: &str, expected: f64) {
    assert_eq!(property(value, name).as_f64(), Some(expected));
}

fn assert_sent_count(socket: &JsValue, expected: u32) {
    assert_eq!(Array::from(&property(socket, "sent")).length(), expected);
}

fn sockets() -> Array {
    Array::from(&js_sys::eval("globalThis.__ppokerSockets").expect("socket list should exist"))
}

fn socket(index: u32) -> JsValue {
    sockets().get(index)
}

fn invoke(socket: &JsValue, callback: &str, event: &JsValue) {
    match callback {
        "onopen" => set_property(socket, "readyState", &JsValue::from_f64(1.0)),
        "onclose" => set_property(socket, "readyState", &JsValue::from_f64(3.0)),
        _ => {}
    }
    property(socket, callback)
        .dyn_into::<Function>()
        .expect("callback should be retained")
        .call1(socket, event)
        .unwrap();
}

fn invoke_event(socket: &JsValue, callback: &str) {
    invoke(
        socket,
        callback,
        &web_sys::Event::new(callback).unwrap().into(),
    );
}

fn message(data: JsValue) -> JsValue {
    let event = Object::new();
    set_property(&event, "data", &data);
    event.into()
}

fn invoke_message(socket: &JsValue, data: impl AsRef<str>) {
    invoke(
        socket,
        "onmessage",
        &message(JsValue::from_str(data.as_ref())),
    );
}

fn room_payload_with(room: &str, phase: &str, vote: &str) -> String {
    serde_json::json!({
        "roomId": room,
        "deck": ["1", "3", "5", "?", "-"],
        "gamePhase": phase,
        "users": [{
            "username": "Browser user",
            "userType": "PARTICIPANT",
            "yourUser": true,
            "cardValue": vote
        }],
        "average": if vote.is_empty() { "0" } else { vote },
        "log": [{ "level": "INFO", "message": "joined" }]
    })
    .to_string()
}

fn invoke_room(socket: &JsValue, room: &str, phase: &str, vote: &str) {
    invoke_message(socket, room_payload_with(room, phase, vote));
}

fn assert_js_error(error: JsValue, code: &str) {
    assert!(error.is_instance_of::<JsError>());
    assert_string(&error, "code", code);
    assert!(property(&error, "message").as_string().is_some());
}

fn coded_error(message: &str, code: &str) -> JsValue {
    let error: JsValue = JsError::new(message).into();
    set_property(&error, "code", &JsValue::from_str(code));
    error
}

fn assert_terminal(snapshot: &JsValue, code: &str) {
    assert_string(snapshot, "status", "closed");
    assert_string(&property(snapshot, "terminalError"), "code", code);
}

fn assert_callbacks_cleared(socket: &JsValue) {
    for callback in ["onopen", "onmessage", "onerror", "onclose"] {
        let callback = property(socket, callback);
        assert!(callback.is_null() || callback.is_undefined());
    }
}

#[wasm_bindgen_test]
fn core_errors_become_actual_javascript_errors_with_stable_codes() {
    for (code, expected) in [
        (ClientErrorCode::NotReady, "NotReady"),
        (ClientErrorCode::InvalidCard, "InvalidCard"),
        (ClientErrorCode::InvalidState, "InvalidState"),
        (ClientErrorCode::Closed, "Closed"),
        (ClientErrorCode::Transport, "Transport"),
        (ClientErrorCode::Protocol, "Protocol"),
    ] {
        assert_js_error(
            client_error_to_js(ClientError {
                code,
                message: "core failure".to_string(),
            }),
            expected,
        );
    }
}

async fn wait(milliseconds: i32) {
    let promise = Promise::new(&mut |resolve, _| {
        web_sys::window()
            .expect("browser test requires a window")
            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
            .expect("setTimeout should be available");
    });
    JsFuture::from(promise)
        .await
        .expect("setTimeout promise should resolve");
}

#[derive(Debug)]
enum LiveAttemptFailure {
    Retryable(String),
    Fatal(String),
}

fn error_diagnostic(error: &JsValue) -> String {
    let code = property(error, "code")
        .as_string()
        .unwrap_or_else(|| "Unknown".to_string());
    let message = property(error, "message")
        .as_string()
        .unwrap_or_else(|| format!("{error:?}"));
    format!("{code}: {message}")
}

fn operational_failure(context: &str, error: JsValue) -> LiveAttemptFailure {
    let code = property(&error, "code")
        .as_string()
        .unwrap_or_else(|| "Unknown".to_string());
    let diagnostic = format!("{context} failed: {}", error_diagnostic(&error));
    match code.as_str() {
        "Transport" | "Closed" => LiveAttemptFailure::Retryable(diagnostic),
        _ => LiveAttemptFailure::Fatal(diagnostic),
    }
}

fn fatal_failure(context: &str, error: JsValue) -> LiveAttemptFailure {
    LiveAttemptFailure::Fatal(format!("{context} failed: {}", error_diagnostic(&error)))
}

async fn connect_live(
    room_name: &str,
    participant_name: &str,
) -> Result<JsValue, LiveAttemptFailure> {
    let options = ClientOptions {
        endpoint: "wss://pp.discordia.network/".to_string(),
        room: room_name.to_string(),
        name: participant_name.to_string(),
        role: ConnectionRole::Participant,
    };
    let options = serde_wasm_bindgen::to_value(&options).map_err(|error| {
        LiveAttemptFailure::Fatal(format!(
            "live client options could not be serialized: {error}"
        ))
    })?;
    let mut client =
        WasmPokerClient::new(options).map_err(|error| fatal_failure("live client setup", error))?;
    let result = async {
        client
            .connect(noop())
            .map_err(|error| operational_failure("connect", error))?;
        let performance = web_sys::window()
            .and_then(|window| window.performance())
            .ok_or_else(|| {
                LiveAttemptFailure::Fatal("browser performance clock is unavailable".to_string())
            })?;
        let deadline = performance.now() + 4_000.0;

        loop {
            let snapshot = client
                .snapshot()
                .map_err(|error| fatal_failure("snapshot serialization", error))?;
            if !property(&snapshot, "room").is_null() {
                return Ok(snapshot);
            }
            if property(&snapshot, "status").as_string().as_deref() == Some("closed") {
                let error = property(&snapshot, "terminalError");
                return Err(if error.is_null() {
                    LiveAttemptFailure::Retryable(
                        "connection closed without a terminal error".to_string(),
                    )
                } else {
                    operational_failure("asynchronous connection", error)
                });
            }
            if performance.now() >= deadline {
                return Err(LiveAttemptFailure::Retryable(
                    "timed out waiting for the initial room snapshot".to_string(),
                ));
            }
            wait(100).await;
        }
    }
    .await;
    client.close();
    result
}

#[wasm_bindgen_test]
fn live_attempt_retries_only_transport_failures() {
    assert!(matches!(
        operational_failure("connect", coded_error("network failed", "Transport")),
        LiveAttemptFailure::Retryable(_)
    ));

    assert!(matches!(
        operational_failure("snapshot", coded_error("invalid snapshot", "Protocol")),
        LiveAttemptFailure::Fatal(_)
    ));
}

#[wasm_bindgen_test]
fn javascript_abi_is_lazy_typed_and_exposes_every_command() {
    let _guard = FakeWebSocketGuard::install();
    let mut client = construct(options(ConnectionRole::Participant));
    let changes = Rc::new(Cell::new(0));
    let callback_changes = changes.clone();
    let on_change: Closure<dyn FnMut()> =
        Closure::new(move || callback_changes.set(callback_changes.get() + 1));

    assert_eq!(sockets().length(), 0);
    let initial = client.snapshot().unwrap();
    assert_number(&initial, "revision", 0.0);
    assert_string(&initial, "status", "disconnected");
    for name in ["terminalError", "room", "localVote", "average"] {
        assert!(property(&initial, name).is_null());
    }

    client
        .connect(on_change.as_ref().unchecked_ref::<Function>().clone())
        .unwrap();
    connect(&mut client);
    let socket = socket(0);
    assert_eq!(sockets().length(), 1);
    let connecting = client.snapshot().unwrap();
    assert_number(&connecting, "revision", 1.0);
    assert_string(&connecting, "status", "connecting");
    assert!(property(&connecting, "room").is_null());
    invoke_event(&socket, "onopen");
    invoke_room(&socket, "typed room", "PLAYING", "");
    let open = client.snapshot().unwrap();
    assert_number(&open, "revision", 3.0);
    assert_string(&open, "status", "open");
    assert_string(&property(&open, "room"), "phase", "playing");
    assert_eq!(changes.get(), 2);

    client.vote("5").unwrap();
    client.retract_vote().unwrap();
    client.rename("Alicia".to_string()).unwrap();
    client.chat("hello".to_string()).unwrap();
    client.reveal().unwrap();
    invoke_room(&socket, "typed room", "CARDS_REVEALED", "5");
    assert_eq!(changes.get(), 3);
    client.start_new_round().unwrap();
    let sent = Array::from(&property(&socket, "sent"));
    for (index, expected) in [
        r#"{"requestType":"PlayCard","cardValue":"5"}"#,
        r#"{"requestType":"PlayCard","cardValue":null}"#,
        r#"{"requestType":"ChangeName","name":"Alicia"}"#,
        r#"{"requestType":"ChatMessage","message":"hello"}"#,
        r#"{"requestType":"RevealCards"}"#,
        r#"{"requestType":"StartNewRound"}"#,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            sent.get(index as u32).as_string().as_deref(),
            Some(expected)
        );
    }

    client.close();
    client.close();
    assert_number(&socket, "closeCount", 1.0);
    assert_callbacks_cleared(&socket);
    let closed = client.snapshot().unwrap();
    assert_number(&closed, "revision", 5.0);
    assert_string(&closed, "status", "closed");
    assert!(property(&closed, "terminalError").is_null());
    assert_js_error(client.connect(noop()).unwrap_err(), "Closed");
    assert_js_error(client.vote("5").unwrap_err(), "Closed");
    assert_js_error(client.chat("late".to_string()).unwrap_err(), "Closed");
    assert_sent_count(&socket, 6);
}

#[wasm_bindgen_test]
fn malformed_javascript_options_throw_an_actual_structured_error() {
    let malformed = Object::new();
    set_property(
        &malformed,
        "endpoint",
        &JsValue::from_str("wss://example.test"),
    );
    let error = WasmPokerClient::new(malformed.into())
        .err()
        .expect("missing options should throw");
    assert_js_error(error.clone(), "InvalidOptions");
    assert_string(&property(&error, "details"), "field", "options");
}

#[wasm_bindgen_test]
fn role_urls_accept_embedded_dots_and_reject_exact_dot_rooms_without_sockets() {
    let _guard = FakeWebSocketGuard::install();

    for (room, role) in [
        (".", ConnectionRole::Participant),
        ("..", ConnectionRole::Spectator),
    ] {
        let invalid = ClientOptions {
            room: room.to_string(),
            ..options(role)
        };
        let error = WasmPokerClient::new(serde_wasm_bindgen::to_value(&invalid).unwrap())
            .err()
            .expect("exact dot room should fail");
        assert_js_error(error.clone(), "InvalidOptions");
        assert_string(&property(&error, "details"), "field", "room");
        assert_eq!(sockets().length(), 0);
    }

    for (index, role, room, name, expected) in [
        (
            0,
            ConnectionRole::Participant,
            "typed room",
            "Browser user",
            "wss://example.test/base/rooms/typed%20room?user=Browser+user&userType=PARTICIPANT",
        ),
        (
            1,
            ConnectionRole::Spectator,
            "release..candidate",
            ".Browser.User.",
            "wss://example.test/base/rooms/release..candidate?user=.Browser.User.&userType=SPECTATOR",
        ),
    ] {
        let mut client_options = options(role);
        client_options.room = room.to_string();
        client_options.name = name.to_string();
        let mut client = construct(client_options);
        connect(&mut client);
        assert_string(&socket(index), "url", expected);
        client.close();
    }
}

#[wasm_bindgen_test]
fn websocket_constructor_failures_are_structured_and_socket_free() {
    let _guard = FakeWebSocketGuard::install();
    let mut client = construct(options(ConnectionRole::Participant));
    js_sys::eval(
        r#"
        globalThis.WebSocket = class {
            constructor() {
                throw new DOMException("blocked", "SecurityError");
            }
        };
        "#,
    )
    .expect("throwing WebSocket should install");

    let error = client.connect(noop()).unwrap_err();
    assert_js_error(error.clone(), "Transport");
    assert_string(
        &error,
        "message",
        "WebSocket connection could not be created.",
    );
    assert_eq!(sockets().length(), 0);
    let snapshot = client.snapshot().unwrap();
    assert_terminal(&snapshot, "Transport");
    assert_js_error(client.connect(noop()).unwrap_err(), "Closed");
}

#[wasm_bindgen_test]
fn public_client_terminal_matrix_covers_callbacks_and_malformed_text() {
    let _guard = FakeWebSocketGuard::install();

    for (index, terminal, expected_code) in [
        (0, "onerror", Some("Transport")),
        (1, "onclose", None),
        (2, "malformed", Some("Protocol")),
    ] {
        let mut client = construct(options(ConnectionRole::Participant));
        connect(&mut client);
        let socket = socket(index);
        invoke_event(&socket, "onopen");
        invoke_room(&socket, "typed room", "PLAYING", "");

        if terminal == "malformed" {
            invoke_message(&socket, "not json");
        } else {
            invoke_event(&socket, terminal);
        }
        assert_js_error(client.vote("5").unwrap_err(), "Closed");
        assert_sent_count(&socket, 0);

        let snapshot = client.snapshot().unwrap();
        assert_string(&snapshot, "status", "closed");
        if let Some(expected_code) = expected_code {
            assert_string(&property(&snapshot, "terminalError"), "code", expected_code);
        } else {
            assert!(property(&snapshot, "terminalError").is_null());
        }
        assert_number(&socket, "closeCount", 1.0);
        assert_callbacks_cleared(&socket);
    }
}

#[wasm_bindgen_test]
fn browser_transport_forwards_callbacks_immediately_and_cleans_up_once() {
    let _guard = FakeWebSocketGuard::install();
    let received = Rc::new(RefCell::new(vec![]));
    let sink_received = received.clone();
    let mut transport = super::transport::BrowserTransport::connect(
        "wss://example.test/rooms/callbacks?user=test&userType=PARTICIPANT",
        Rc::new(move |event| sink_received.borrow_mut().push(event)),
    )
    .unwrap();
    let socket = socket(0);
    assert_string(&socket, "binaryType", "arraybuffer");
    for callback in ["onopen", "onmessage", "onerror", "onclose"] {
        assert!(property(&socket, callback).is_function());
    }
    assert!(transport.send_text("connecting".to_string()).is_err());
    invoke_event(&socket, "onopen");
    transport.send_text("open".to_string()).unwrap();
    invoke_message(&socket, "text");
    let bytes = js_sys::Uint8Array::new_with_length(3);
    invoke(&socket, "onmessage", &message(bytes.buffer().into()));
    invoke(&socket, "onmessage", &message(Object::new().into()));
    assert_eq!(
        received.borrow().as_slice(),
        [
            TransportEvent::Opened,
            TransportEvent::Text("text".to_string()),
            TransportEvent::Binary { length: 3 },
            TransportEvent::Binary { length: 0 },
        ]
    );

    let late_message = property(&socket, "onmessage")
        .dyn_into::<Function>()
        .unwrap();
    transport.close();
    transport.close();
    late_message
        .call1(&socket, &message(JsValue::from_str("late")))
        .unwrap();
    assert_eq!(received.borrow().len(), 4);
    assert!(transport.send_text("cleaned up".to_string()).is_err());
    assert_sent_count(&socket, 1);
    assert_number(&socket, "closeCount", 1.0);
    assert_callbacks_cleared(&socket);
}

#[wasm_bindgen_test]
fn oversized_text_commits_prior_public_state_and_ignores_late_rooms() {
    let _guard = FakeWebSocketGuard::install();
    let mut client = construct(options(ConnectionRole::Participant));
    connect(&mut client);
    let socket = socket(0);

    invoke_event(&socket, "onopen");
    invoke_room(&socket, "first room", "PLAYING", "");
    invoke_room(&socket, "second room", "CARDS_REVEALED", "3");
    let late_message = property(&socket, "onmessage")
        .dyn_into::<Function>()
        .unwrap();
    invoke_message(&socket, "x".repeat(MAX_TEXT_MESSAGE_BYTES + 1));
    assert_number(&socket, "closeCount", 1.0);
    late_message
        .call1(
            &socket,
            &message(JsValue::from_str(&room_payload_with(
                "late room",
                "PLAYING",
                "",
            ))),
        )
        .unwrap();

    let snapshot = client.snapshot().unwrap();
    assert_terminal(&snapshot, "Transport");
    assert_string(&property(&snapshot, "room"), "name", "second room");
    let history = Array::from(&property(&snapshot, "history"));
    assert_eq!(history.length(), 1);
    assert_number(&history.get(0), "roundNumber", 1.0);
    assert_string(
        &property(&snapshot, "terminalError"),
        "message",
        MESSAGE_TOO_LARGE_ERROR,
    );
    assert_number(&socket, "closeCount", 1.0);
    assert_callbacks_cleared(&socket);

    let revision = property(&snapshot, "revision").as_f64();
    let unchanged = client.snapshot().unwrap();
    assert_eq!(property(&unchanged, "revision").as_f64(), revision);
    assert_string(&property(&unchanged, "room"), "name", "second room");
}

#[wasm_bindgen_test]
#[ignore = "requires the live upstream Planning Poker server"]
async fn real_upstream_accepts_a_browser_participant() {
    assert!(
        js_sys::eval("globalThis.__ppokerSockets")
            .expect("global lookup should succeed")
            .is_undefined(),
        "live upstream proof must use the real browser WebSocket"
    );
    let unique = format!(
        "{}-{}",
        js_sys::Date::now() as u64,
        (js_sys::Math::random() * 1_000_000_000.0) as u64
    );
    let mut failures = vec![];

    for attempt in 0..2 {
        let room_name = format!("wasm-live-{unique}-{attempt}");
        let participant_name = format!("browser-live-{unique}-{attempt}");
        match connect_live(&room_name, &participant_name).await {
            Ok(snapshot) => {
                let room = property(&snapshot, "room");
                assert_string(&room, "name", &room_name);
                let players = Array::from(&property(&room, "players"));
                let local_player = (0..players.length())
                    .map(|index| players.get(index))
                    .find(|player| property(player, "isYou").as_bool() == Some(true))
                    .expect("authoritative room should contain the local participant");
                assert_string(&local_player, "name", &participant_name);
                assert_string(&local_player, "userType", "player");
                return;
            }
            Err(LiveAttemptFailure::Retryable(error)) => {
                failures.push(format!("attempt {}: {error}", attempt + 1));
            }
            Err(LiveAttemptFailure::Fatal(error)) => {
                panic!("real upstream browser setup or protocol failure: {error}");
            }
        }
    }

    panic!(
        "real upstream browser connection failed: {}",
        failures.join("; ")
    );
}
