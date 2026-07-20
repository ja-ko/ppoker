use js_sys::{Array, Function, Object, Promise, Reflect};
use ppoker_core::client::{Transport, TransportEvent};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;

use super::*;
use crate::transport_queue::{MAX_QUEUED_EVENTS, MAX_QUEUED_TEXT_BYTES, QUEUE_OVERFLOW_ERROR};

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
                    this.sent = [];
                    this.closeCount = 0;
                    this.onopen = null;
                    this.onmessage = null;
                    this.onerror = null;
                    this.onclose = null;
                    globalThis.__ppokerSockets.push(this);
                }
                send(message) { this.sent.push(message); }
                close() { this.closeCount += 1; }
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

fn property(value: &JsValue, name: &str) -> JsValue {
    Reflect::get(value, &JsValue::from_str(name)).unwrap()
}

fn socket(index: u32) -> JsValue {
    let sockets =
        Array::from(&js_sys::eval("globalThis.__ppokerSockets").expect("socket list should exist"));
    sockets.get(index)
}

fn invoke(socket: &JsValue, callback: &str, event: &JsValue) {
    property(socket, callback)
        .dyn_into::<Function>()
        .expect("callback should be retained")
        .call1(socket, event)
        .unwrap();
}

fn message(data: JsValue) -> JsValue {
    let event = Object::new();
    Reflect::set(&event, &JsValue::from_str("data"), &data).unwrap();
    event.into()
}

fn room_payload() -> String {
    room_payload_with("typed room", "PLAYING", "")
}

fn room_payload_with(room: &str, phase: &str, vote: &str) -> String {
    serde_json::json!({
        "roomId": room,
        "deck": ["1", "3", "5", "?"],
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

fn assert_js_error(error: JsValue, code: &str) {
    assert!(error.is_instance_of::<JsError>());
    assert_eq!(property(&error, "code").as_string().as_deref(), Some(code));
    assert!(property(&error, "message").as_string().is_some());
}

fn assert_callbacks_cleared(socket: &JsValue) {
    for callback in ["onopen", "onmessage", "onerror", "onclose"] {
        let callback = property(socket, callback);
        assert!(callback.is_null() || callback.is_undefined());
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
            .connect()
            .map_err(|error| operational_failure("connect", error))?;
        let performance = web_sys::window()
            .and_then(|window| window.performance())
            .ok_or_else(|| {
                LiveAttemptFailure::Fatal("browser performance clock is unavailable".to_string())
            })?;
        let deadline = performance.now() + 4_000.0;

        loop {
            client.poll();
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
    let transport = JsError::new("network failed");
    Reflect::set(
        &transport,
        &JsValue::from_str("code"),
        &JsValue::from_str("Transport"),
    )
    .unwrap();
    assert!(matches!(
        operational_failure("connect", transport.into()),
        LiveAttemptFailure::Retryable(_)
    ));

    let protocol = JsError::new("invalid snapshot");
    Reflect::set(
        &protocol,
        &JsValue::from_str("code"),
        &JsValue::from_str("Protocol"),
    )
    .unwrap();
    assert!(matches!(
        operational_failure("snapshot", protocol.into()),
        LiveAttemptFailure::Fatal(_)
    ));
}

#[wasm_bindgen_test]
fn construction_is_side_effect_free_and_structured_for_both_roles() {
    let _guard = FakeWebSocketGuard::install();

    for role in [ConnectionRole::Participant, ConnectionRole::Spectator] {
        let mut client = construct(options(role));
        assert_eq!(
            Array::from(&js_sys::eval("globalThis.__ppokerSockets").unwrap()).length(),
            0
        );

        let snapshot = client.snapshot().unwrap();
        assert_eq!(property(&snapshot, "revision").as_f64(), Some(0.0));
        assert_eq!(
            property(&snapshot, "status").as_string().as_deref(),
            Some("disconnected")
        );
        assert!(property(&snapshot, "terminalError").is_null());
        assert!(property(&snapshot, "room").is_null());
        assert!(property(&snapshot, "localVote").is_null());
        assert!(property(&snapshot, "average").is_null());

        assert_js_error(client.vote("5").unwrap_err(), "NotReady");
        client.close();
        client.close();
        assert!(!client.poll());
        let closed = client.snapshot().unwrap();
        assert_eq!(property(&closed, "revision").as_f64(), Some(1.0));
        assert_eq!(
            property(&closed, "status").as_string().as_deref(),
            Some("closed")
        );
        assert_js_error(
            client.chat("after close".to_string()).unwrap_err(),
            "Closed",
        );
    }
}

#[wasm_bindgen_test]
fn malformed_options_throw_actual_errors_with_structured_details() {
    let invalid = ClientOptions {
        endpoint: "https://example.test".to_string(),
        ..options(ConnectionRole::Participant)
    };
    let error = WasmPokerClient::new(serde_wasm_bindgen::to_value(&invalid).unwrap())
        .err()
        .expect("invalid endpoint should throw");
    assert_js_error(error.clone(), "InvalidOptions");
    let details = property(&error, "details");
    assert_eq!(
        property(&details, "field").as_string().as_deref(),
        Some("endpoint")
    );

    let malformed = Object::new();
    Reflect::set(
        &malformed,
        &JsValue::from_str("endpoint"),
        &JsValue::from_str("wss://example.test"),
    )
    .unwrap();
    let error = WasmPokerClient::new(malformed.into())
        .err()
        .expect("missing options should throw");
    assert_js_error(error.clone(), "InvalidOptions");
    assert_eq!(
        property(&property(&error, "details"), "field")
            .as_string()
            .as_deref(),
        Some("options")
    );
}

#[wasm_bindgen_test]
fn dot_rooms_fail_synchronously_without_creating_sockets() {
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
            .expect("dot room should throw");

        assert_js_error(error.clone(), "InvalidOptions");
        assert_eq!(
            property(&property(&error, "details"), "field")
                .as_string()
                .as_deref(),
            Some("room")
        );
        assert_eq!(
            Array::from(&js_sys::eval("globalThis.__ppokerSockets").unwrap()).length(),
            0
        );
    }
}

#[wasm_bindgen_test]
fn browser_transport_queues_without_blocking_and_cleans_callbacks_terminally() {
    let _guard = FakeWebSocketGuard::install();
    let mut client = construct(options(ConnectionRole::Participant));

    client.connect().unwrap();
    client.connect().unwrap();
    let socket = socket(0);
    assert_eq!(
        Array::from(&js_sys::eval("globalThis.__ppokerSockets").unwrap()).length(),
        1
    );
    assert_eq!(
        property(&socket, "url").as_string().as_deref(),
        Some("wss://example.test/base/rooms/typed%20room?user=Browser+user&userType=PARTICIPANT")
    );
    assert_eq!(
        property(&socket, "binaryType").as_string().as_deref(),
        Some("arraybuffer")
    );
    for callback in ["onopen", "onmessage", "onerror", "onclose"] {
        assert!(property(&socket, callback).is_function());
    }
    let connecting = client.snapshot().unwrap();
    assert_eq!(property(&connecting, "revision").as_f64(), Some(1.0));
    assert_eq!(
        property(&connecting, "status").as_string().as_deref(),
        Some("connecting")
    );

    invoke(
        &socket,
        "onopen",
        &web_sys::Event::new("open").unwrap().into(),
    );
    invoke(
        &socket,
        "onmessage",
        &message(JsValue::from_str(&room_payload())),
    );
    let performance = web_sys::window().unwrap().performance().unwrap();
    let before_start = performance.now().floor();
    assert!(client.poll());
    let after_start = performance.now().floor();
    let open = client.snapshot().unwrap();
    assert_eq!(property(&open, "revision").as_f64(), Some(2.0));
    assert_eq!(
        property(&open, "status").as_string().as_deref(),
        Some("open")
    );
    let room = property(&open, "room");
    assert_eq!(
        property(&room, "phase").as_string().as_deref(),
        Some("playing")
    );
    let start = property(&open, "roundStartedAtMs").as_f64().unwrap();
    assert!(start.is_finite());
    assert_eq!(start.fract(), 0.0);
    assert!(start >= before_start && start <= after_start);

    client.vote("5").unwrap();
    assert_eq!(
        Array::from(&property(&socket, "sent"))
            .get(0)
            .as_string()
            .as_deref(),
        Some(r#"{"requestType":"PlayCard","cardValue":"5"}"#)
    );
    let voted = client.snapshot().unwrap();
    assert_eq!(
        property(&property(&voted, "localVote"), "kind")
            .as_string()
            .as_deref(),
        Some("number")
    );

    let bytes = js_sys::Uint8Array::new_with_length(3);
    invoke(&socket, "onmessage", &message(bytes.buffer().into()));
    assert!(!client.poll());

    invoke(
        &socket,
        "onerror",
        &web_sys::Event::new("error").unwrap().into(),
    );
    assert!(client.poll());
    let failed = client.snapshot().unwrap();
    assert_eq!(
        property(&failed, "status").as_string().as_deref(),
        Some("closed")
    );
    assert_eq!(
        property(&property(&failed, "terminalError"), "code")
            .as_string()
            .as_deref(),
        Some("Transport")
    );
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    assert_callbacks_cleared(&socket);
    client.close();
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    assert!(!client.poll());
}

#[wasm_bindgen_test]
fn browser_transport_bounds_event_flood_and_cleans_up_once() {
    let _guard = FakeWebSocketGuard::install();
    let mut transport = super::transport::BrowserTransport::connect(
        "wss://example.test/rooms/flood?user=test&userType=PARTICIPANT",
    )
    .unwrap();
    let socket = socket(0);
    let bytes = js_sys::Uint8Array::new_with_length(3);
    let binary_message = message(bytes.buffer().into());

    for _ in 0..MAX_QUEUED_EVENTS {
        invoke(&socket, "onmessage", &binary_message);
    }
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(0.0));

    invoke(&socket, "onmessage", &binary_message);
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    for _ in 0..16 {
        invoke(
            &socket,
            "onmessage",
            &message(JsValue::from_str("late payload")),
        );
        invoke(
            &socket,
            "onopen",
            &web_sys::Event::new("open").unwrap().into(),
        );
    }
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));

    for _ in 0..MAX_QUEUED_EVENTS {
        assert_eq!(
            transport.poll_event(),
            Some(TransportEvent::Binary { length: 3 })
        );
    }
    assert_eq!(
        transport.poll_event(),
        Some(TransportEvent::Error(QUEUE_OVERFLOW_ERROR.to_string()))
    );
    assert_eq!(transport.poll_event(), None);

    transport.close();
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    assert_callbacks_cleared(&socket);
}

#[wasm_bindgen_test]
fn oversized_text_preserves_prior_snapshots_then_fails_terminally() {
    let _guard = FakeWebSocketGuard::install();
    let mut client = construct(options(ConnectionRole::Participant));
    client.connect().unwrap();
    let socket = socket(0);

    invoke(
        &socket,
        "onopen",
        &web_sys::Event::new("open").unwrap().into(),
    );
    invoke(
        &socket,
        "onmessage",
        &message(JsValue::from_str(&room_payload_with(
            "first room",
            "PLAYING",
            "",
        ))),
    );
    invoke(
        &socket,
        "onmessage",
        &message(JsValue::from_str(&room_payload_with(
            "second room",
            "CARDS_REVEALED",
            "3",
        ))),
    );
    invoke(
        &socket,
        "onmessage",
        &message(JsValue::from_str(&"x".repeat(MAX_QUEUED_TEXT_BYTES + 1))),
    );
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    invoke(
        &socket,
        "onmessage",
        &message(JsValue::from_str(&room_payload_with(
            "late room",
            "PLAYING",
            "",
        ))),
    );

    assert!(client.poll());
    let snapshot = client.snapshot().unwrap();
    assert_eq!(
        property(&snapshot, "status").as_string().as_deref(),
        Some("closed")
    );
    assert_eq!(
        property(&property(&snapshot, "room"), "name")
            .as_string()
            .as_deref(),
        Some("second room")
    );
    assert_eq!(Array::from(&property(&snapshot, "history")).length(), 1);
    assert_eq!(
        property(&property(&snapshot, "terminalError"), "message")
            .as_string()
            .as_deref(),
        Some(QUEUE_OVERFLOW_ERROR)
    );
    assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    assert_callbacks_cleared(&socket);
    assert!(!client.poll());
}

#[wasm_bindgen_test]
fn participant_and_spectator_use_exact_transport_urls_without_a_server() {
    let _guard = FakeWebSocketGuard::install();

    for (index, role, user_type) in [
        (0, ConnectionRole::Participant, "PARTICIPANT"),
        (1, ConnectionRole::Spectator, "SPECTATOR"),
    ] {
        let mut client = construct(options(role));
        client.connect().unwrap();
        let socket = socket(index);
        assert!(property(&socket, "url")
            .as_string()
            .unwrap()
            .ends_with(&format!("userType={user_type}")));
        client.close();
        assert_eq!(property(&socket, "closeCount").as_f64(), Some(1.0));
    }
}

#[wasm_bindgen_test]
fn valid_dot_containing_rooms_and_names_work_for_both_roles() {
    let _guard = FakeWebSocketGuard::install();

    for (index, role, user_type) in [
        (0, ConnectionRole::Participant, "PARTICIPANT"),
        (1, ConnectionRole::Spectator, "SPECTATOR"),
    ] {
        let mut client_options = options(role);
        client_options.room = "release..candidate".to_string();
        client_options.name = ".Browser.User.".to_string();
        let mut client = construct(client_options);
        client.connect().unwrap();
        let expected = format!(
            "wss://example.test/base/rooms/release..candidate?user=.Browser.User.&userType={user_type}"
        );
        assert_eq!(
            property(&socket(index), "url").as_string().as_deref(),
            Some(expected.as_str())
        );
        client.close();
    }
}

#[wasm_bindgen_test]
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
                assert_eq!(
                    property(&room, "name").as_string().as_deref(),
                    Some(room_name.as_str())
                );
                let players = Array::from(&property(&room, "players"));
                let local_player = (0..players.length())
                    .map(|index| players.get(index))
                    .find(|player| property(player, "isYou").as_bool() == Some(true))
                    .expect("authoritative room should contain the local participant");
                assert_eq!(
                    property(&local_player, "name").as_string().as_deref(),
                    Some(participant_name.as_str())
                );
                assert_eq!(
                    property(&local_player, "userType").as_string().as_deref(),
                    Some("player")
                );
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
