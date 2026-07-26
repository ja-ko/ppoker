use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use ppoker_core::client::{ClientError, ClientSnapshot, TransportEvent};
use ppoker_core::models::{
    GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Player, Room, RoomEvent,
    RoomEventEntry, UserType, Vote, VoteData,
};

use super::*;

#[derive(Default)]
struct ManualClock {
    now: Cell<Duration>,
}

impl Clock for ManualClock {
    fn now(&self) -> Duration {
        self.now.get()
    }
}

#[derive(Default)]
struct FakeTransportState {
    events: Option<EventSink>,
    sent: Vec<String>,
    closes: usize,
}

struct FakeTransport(Rc<RefCell<FakeTransportState>>);

impl Transport for FakeTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        None
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        self.0.borrow_mut().sent.push(message);
        Ok(())
    }

    fn close(&mut self) {
        self.0.borrow_mut().closes += 1;
    }
}

fn options(role: ConnectionRole) -> ClientOptions {
    ClientOptions {
        endpoint: "wss://example.test/base/".to_string(),
        room: "planning / 東京".to_string(),
        name: "Alice & Bob".to_string(),
        role,
    }
}

fn unused_factory() -> TransportFactory {
    Box::new(|_, _| -> Result<Box<dyn Transport>, String> {
        panic!("invalid options must not construct a transport")
    })
}

fn dispatch(state: &Rc<RefCell<FakeTransportState>>, event: TransportEvent) {
    let events = state
        .borrow()
        .events
        .as_ref()
        .expect("connected transports retain their event sink")
        .clone();
    events(event);
}

fn invalid_options(options: ClientOptions) -> InvalidOptionsError {
    WasmPokerClient::from_options(options, Rc::new(ManualClock::default()), unused_factory())
        .err()
        .expect("options should be rejected")
}

fn facade_with_state() -> (WasmPokerClient, Rc<RefCell<FakeTransportState>>) {
    let state = Rc::new(RefCell::new(FakeTransportState::default()));
    let transport_state = state.clone();
    let facade = WasmPokerClient::from_options(
        options(ConnectionRole::Participant),
        Rc::new(ManualClock::default()),
        Box::new(move |_, events| {
            transport_state.borrow_mut().events = Some(events);
            Ok(Box::new(FakeTransport(transport_state.clone())))
        }),
    )
    .unwrap();
    (facade, state)
}

#[test]
fn options_accept_both_roles_and_report_precise_validation_errors() {
    for role in [ConnectionRole::Participant, ConnectionRole::Spectator] {
        WasmPokerClient::from_options(
            options(role),
            Rc::new(ManualClock::default()),
            unused_factory(),
        )
        .expect("valid options should construct the host facade");
    }

    for endpoint in [
        "not a URL",
        "https://example.test",
        "wss://user@example.test",
        "wss://example.test?query=1",
        "wss://example.test#fragment",
    ] {
        let mut invalid = options(ConnectionRole::Participant);
        invalid.endpoint = endpoint.to_string();
        let error = invalid_options(invalid);
        assert_eq!(error.details.field, "endpoint", "endpoint: {endpoint}");
        assert_eq!(error.message, error.details.reason);
    }

    for room in [".", ".."] {
        let mut invalid = options(ConnectionRole::Spectator);
        invalid.room = room.to_string();
        let error = invalid_options(invalid);
        assert_eq!(error.message, "Room must not be `.` or `..`.");
        assert_eq!(error.details.field, "room");
        assert_eq!(error.details.reason, "Room must not be `.` or `..`.");
    }
}

#[test]
fn host_facade_delegates_each_export_once_and_closes_once() {
    let (mut facade, state) = facade_with_state();

    facade.connect().unwrap();
    facade.connect().unwrap();
    dispatch(&state, TransportEvent::Opened);
    dispatch(&state, TransportEvent::Text(room_payload("PLAYING", "")));
    facade.vote("5").unwrap();
    facade.retract_vote().unwrap();
    facade.rename("Alicia".to_string()).unwrap();
    facade.chat("hello".to_string()).unwrap();
    facade.announce_auto_reveal(3000.0).unwrap();
    facade.reveal().unwrap();
    dispatch(
        &state,
        TransportEvent::Text(room_payload("CARDS_REVEALED", "5")),
    );
    facade.start_new_round().unwrap();
    assert_eq!(state.borrow().sent.len(), 7);
    assert_eq!(
        state.borrow().sent[4],
        r#"{"requestType":"ClientBroadcast","payload":"{\"protocol\":\"ppoker\",\"version\":1,\"event\":{\"kind\":\"autoRevealAnnounced\",\"value\":{\"countdownMs\":3000}}}"}"#
    );
    dispatch(&state, TransportEvent::Text("not json".to_string()));
    assert_eq!(facade.client.borrow().status(), ConnectionStatus::Closed);

    facade.close();
    facade.close();
    assert_eq!(state.borrow().closes, 1);
}

#[test]
fn auto_reveal_countdown_preserves_core_readiness_error_precedence() {
    let (mut facade, state) = facade_with_state();
    assert_eq!(
        facade.announce_auto_reveal_checked(-1.0).unwrap_err().code,
        ClientErrorCode::NotReady
    );

    facade.connect().unwrap();
    assert_eq!(
        facade
            .announce_auto_reveal_checked(f64::NAN)
            .unwrap_err()
            .code,
        ClientErrorCode::NotReady
    );

    dispatch(&state, TransportEvent::Opened);
    assert_eq!(
        facade
            .announce_auto_reveal_checked(f64::INFINITY)
            .unwrap_err()
            .code,
        ClientErrorCode::Protocol
    );

    facade.close();
    assert_eq!(
        facade
            .announce_auto_reveal_checked(f64::from(u32::MAX) + 1.0)
            .unwrap_err()
            .code,
        ClientErrorCode::Closed
    );
    assert!(state.borrow().sent.is_empty());
}

#[test]
fn auto_reveal_countdown_rejects_lossy_javascript_numbers() {
    for invalid in [
        -1.0,
        1.5,
        f64::NAN,
        f64::INFINITY,
        f64::from(u32::MAX) + 1.0,
    ] {
        let error = auto_reveal_countdown_from_js(invalid).unwrap_err();
        assert_eq!(error.code, ClientErrorCode::Protocol, "value: {invalid}");
    }
    assert_eq!(
        auto_reveal_countdown_from_js(3000.0).unwrap(),
        Duration::from_millis(3000)
    );
    assert_eq!(
        auto_reveal_countdown_from_js(f64::from(u32::MAX)).unwrap(),
        Duration::from_millis(u64::from(u32::MAX))
    );
}

#[test]
fn event_sink_releases_client_before_notifying() {
    let client = Rc::new(RefCell::new(Client::new(
        "Alice".to_string(),
        Rc::new(ManualClock::default()),
    )));
    let notifier_client = client.clone();
    let notifications = Rc::new(Cell::new(0));
    let notifier_notifications = notifications.clone();
    let events = event_sink(
        Rc::downgrade(&client),
        Rc::new(move || {
            assert!(notifier_client.try_borrow_mut().is_ok());
            notifier_notifications.set(notifier_notifications.get() + 1);
        }),
    );

    events(TransportEvent::Opened);

    assert_eq!(notifications.get(), 1);
    assert_eq!(client.borrow().status(), ConnectionStatus::Open);
}

fn room_payload(phase: &str, vote: &str) -> String {
    serde_json::json!({
        "roomId": "planning / 東京",
        "deck": ["1", "3", "5", "?"],
        "gamePhase": phase,
        "users": [{
            "username": "Alice & Bob",
            "userType": "PARTICIPANT",
            "yourUser": true,
            "cardValue": vote
        }],
        "average": "0",
        "log": []
    })
    .to_string()
}

#[test]
fn core_error_codes_have_the_stable_serialized_shape_used_by_javascript() {
    for (code, expected) in [
        (ClientErrorCode::NotReady, "NotReady"),
        (ClientErrorCode::InvalidCard, "InvalidCard"),
        (ClientErrorCode::InvalidState, "InvalidState"),
        (ClientErrorCode::Closed, "Closed"),
        (ClientErrorCode::Transport, "Transport"),
        (ClientErrorCode::Protocol, "Protocol"),
    ] {
        let error = ClientError {
            code,
            message: "invalid".to_string(),
        };
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "code": expected,
                "message": "invalid"
            })
        );
    }
}

#[test]
fn generated_declarations_are_strongly_typed_and_match_null_runtime_values() {
    let declarations = [
        ConnectionRole::DECL,
        ClientOptions::DECL,
        ConnectionStatus::DECL,
        ClientErrorCode::DECL,
        ClientError::DECL,
        InvalidOptionsDetails::DECL,
        UserType::DECL,
        GamePhase::DECL,
        VoteData::DECL,
        Vote::DECL,
        Player::DECL,
        Room::DECL,
        RoomEvent::DECL,
        RoomEventEntry::DECL,
        LogLevel::DECL,
        LogSource::DECL,
        LogEntry::DECL,
        HistoryEntry::DECL,
        ClientSnapshot::DECL,
    ]
    .join("\n");

    let expected = [
        "export type ConnectionRole",
        "export interface ClientOptions",
        "endpoint: string",
        "role: ConnectionRole",
        "export type Vote",
        "export interface Room",
        "export type RoomEvent",
        "countdownMs: number",
        "export interface RoomEventEntry",
        "event: RoomEvent",
        "export interface ClientSnapshot",
        "revision: number",
        "InvalidCard",
        "InvalidState",
        "terminalError: ClientError | null",
        "room: Room | null",
        "roomEvents: RoomEventEntry[]",
        "average: number | null",
    ];
    let missing = expected
        .iter()
        .find(|expected| !declarations.contains(**expected));
    assert!(
        missing.is_none(),
        "missing `{missing:?}` from generated declarations:\n{declarations}"
    );
    let forbidden = ["any", "bigint", "undefined"]
        .into_iter()
        .find(|forbidden| declarations.contains(forbidden));
    assert!(
        forbidden.is_none(),
        "generated declarations contain `{forbidden:?}`:\n{declarations}"
    );
}
