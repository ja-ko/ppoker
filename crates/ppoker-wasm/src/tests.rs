use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use ppoker_core::client::TransportEvent;
use ppoker_core::models::{GamePhase, LogLevel, LogSource, Player, UserType, Vote};
use ppoker_core::protocol::decode_room_snapshot;
use serde_json::Value;

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

#[derive(Default)]
struct FakeFactoryState {
    urls: Vec<String>,
    error: Option<String>,
}

struct FakeFactory {
    factory: Rc<RefCell<FakeFactoryState>>,
    transport: Rc<RefCell<FakeTransportState>>,
}

type FacadeFixture = (
    ClientFacade,
    Rc<ManualClock>,
    Rc<RefCell<FakeFactoryState>>,
    Rc<RefCell<FakeTransportState>>,
);

impl TransportFactory for FakeFactory {
    fn create(&mut self, url: &str) -> Result<Box<dyn Transport>, String> {
        let mut factory = self.factory.borrow_mut();
        factory.urls.push(url.to_string());
        if let Some(error) = factory.error.clone() {
            Err(error)
        } else {
            Ok(Box::new(FakeTransport(self.transport.clone())))
        }
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

fn facade(role: ConnectionRole) -> FacadeFixture {
    let clock = Rc::new(ManualClock::default());
    let factory = Rc::new(RefCell::new(FakeFactoryState::default()));
    let transport = Rc::new(RefCell::new(FakeTransportState::default()));
    let client = ClientFacade::new(
        options(role),
        clock.clone(),
        Box::new(FakeFactory {
            factory: factory.clone(),
            transport: transport.clone(),
        }),
    )
    .unwrap();
    (client, clock, factory, transport)
}

fn room_payload(phase: &str, alice_vote: &str, bob_vote: &str, numeric: bool) -> String {
    serde_json::json!({
        "roomId": "planning / 東京",
        "deck": ["1", "3", "5", "?"],
        "gamePhase": phase,
        "users": [
            {
                "username": "Alice & Bob",
                "userType": "PARTICIPANT",
                "yourUser": true,
                "cardValue": alice_vote
            },
            {
                "username": "Observer",
                "userType": "SPECTATOR",
                "yourUser": false,
                "cardValue": ""
            },
            {
                "username": "Future",
                "userType": "FUTURE_ROLE",
                "yourUser": false,
                "cardValue": bob_vote
            }
        ],
        "average": if numeric { "4" } else { "0" },
        "log": [
            { "level": "INFO", "message": "joined" },
            { "level": "CHAT", "message": "hello" },
            { "level": "ERROR", "message": "problem" }
        ]
    })
    .to_string()
}

fn push(transport: &Rc<RefCell<FakeTransportState>>, event: TransportEvent) {
    transport.borrow_mut().events.push_back(event);
}

fn assert_code(result: Result<(), FacadeError>, code: FacadeErrorCode) {
    assert_eq!(result.unwrap_err().code, code);
}

#[test]
fn options_validate_with_shared_url_policy_and_both_roles() {
    for (role, user_type) in [
        (ConnectionRole::Participant, "PARTICIPANT"),
        (ConnectionRole::Spectator, "SPECTATOR"),
    ] {
        let (mut client, _, factory, _) = facade(role);
        assert!(factory.borrow().urls.is_empty());
        client.connect().unwrap();
        assert_eq!(factory.borrow().urls.len(), 1);
        let url = &factory.borrow().urls[0];
        assert!(
            url.starts_with("wss://example.test/base/rooms/planning%20%2F%20%E6%9D%B1%E4%BA%AC?")
        );
        assert!(url.contains("user=Alice+%26+Bob"));
        assert!(url.ends_with(&format!("userType={user_type}")));
        client.connect().unwrap();
        assert_eq!(factory.borrow().urls.len(), 1);
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
        let error = ClientFacade::new(
            invalid,
            Rc::new(ManualClock::default()),
            Box::new(BrowserTransportFactory),
        )
        .err()
        .expect("endpoint should be rejected");
        assert_eq!(error.code, FacadeErrorCode::InvalidOptions);
        assert_eq!(error.details.unwrap().field, "endpoint");
    }
}

#[test]
fn dot_room_options_fail_before_transport_construction() {
    for room in [".", ".."] {
        let factory = Rc::new(RefCell::new(FakeFactoryState::default()));
        let transport = Rc::new(RefCell::new(FakeTransportState::default()));
        let mut invalid = options(ConnectionRole::Participant);
        invalid.room = room.to_string();

        let error = ClientFacade::new(
            invalid,
            Rc::new(ManualClock::default()),
            Box::new(FakeFactory {
                factory: factory.clone(),
                transport,
            }),
        )
        .err()
        .expect("dot room should be rejected");

        assert_eq!(error.code, FacadeErrorCode::InvalidOptions);
        assert_eq!(error.message, "Room must not be `.` or `..`.");
        assert_eq!(
            error.details,
            Some(InvalidOptionsDetails {
                field: "room".to_string(),
                reason: "Room must not be `.` or `..`.".to_string(),
            })
        );
        assert!(factory.borrow().urls.is_empty());
    }
}

#[test]
fn initial_snapshot_is_disconnected_structured_and_side_effect_free() {
    let (client, _, factory, _) = facade(ConnectionRole::Spectator);

    let snapshot = client.snapshot().unwrap();

    assert_eq!(snapshot.revision, 0);
    assert_eq!(snapshot.status, ConnectionStatus::Disconnected);
    assert_eq!(snapshot.terminal_error, None);
    assert_eq!(snapshot.room, None);
    assert_eq!(snapshot.local_name, "Alice & Bob");
    assert_eq!(snapshot.local_vote, None);
    assert!(snapshot.log.is_empty());
    assert_eq!(snapshot.round_number, 0);
    assert_eq!(snapshot.round_started_at_ms, None);
    assert!(snapshot.history.is_empty());
    assert_eq!(snapshot.average, None);
    assert!(factory.borrow().urls.is_empty());
}

#[test]
fn polling_batches_status_room_history_activity_and_revision_once() {
    let (mut client, clock, _, transport) = facade(ConnectionRole::Participant);
    client.connect().unwrap();
    assert_eq!(client.snapshot().unwrap().revision, 1);

    push(&transport, TransportEvent::Opened);
    push(
        &transport,
        TransportEvent::Text(room_payload("PLAYING", "", "", false)),
    );
    push(
        &transport,
        TransportEvent::Text(room_payload("PLAYING", "", "", false)),
    );
    assert!(client.poll());
    let playing = client.snapshot().unwrap();
    assert_eq!(playing.revision, 2);
    assert_eq!(playing.status, ConnectionStatus::Open);
    assert_eq!(playing.room.as_ref().unwrap().phase, GamePhase::Playing);
    assert_eq!(playing.room.as_ref().unwrap().players.len(), 3);
    assert_eq!(
        playing.room.as_ref().unwrap().players[1].user_type,
        UserType::Spectator
    );
    assert_eq!(
        playing.room.as_ref().unwrap().players[2].user_type,
        UserType::Unknown
    );
    assert_eq!(playing.log.len(), 3);
    assert_eq!(playing.log[0].level, LogLevel::Info);
    assert_eq!(playing.log[1].level, LogLevel::Chat);
    assert_eq!(playing.log[2].level, LogLevel::Error);
    assert_eq!(playing.log[0].source, LogSource::Server);
    assert_eq!(playing.round_started_at_ms, Some(0.0));
    assert!(!client.poll());
    assert_eq!(client.snapshot().unwrap().revision, 2);

    clock.advance(Duration::from_millis(2500));
    push(
        &transport,
        TransportEvent::Text(room_payload("CARDS_REVEALED", "3", "5", true)),
    );
    assert!(client.poll());
    let revealed = client.snapshot().unwrap();
    assert_eq!(revealed.revision, 3);
    assert_eq!(revealed.average, Some(4.0));
    assert_eq!(revealed.history.len(), 1);
    assert_eq!(revealed.history[0].average, Some(4.0));
    assert_eq!(revealed.history[0].length, Duration::from_millis(2500));
    assert_eq!(revealed.history[0].votes.len(), 3);
    assert_eq!(
        revealed.room.unwrap().players[0].vote,
        Vote::Revealed(VoteData::Number(3))
    );

    clock.advance(Duration::from_secs(30));
    assert_eq!(client.snapshot().unwrap().revision, 3);
}

#[test]
fn all_commands_delegate_to_core_policy_and_update_only_visible_state() {
    let (mut client, _, _, transport) = facade(ConnectionRole::Spectator);
    assert_code(
        client.vote("5"),
        FacadeErrorCode::Core(ClientErrorCode::NotReady),
    );
    assert_code(
        client.rename("Alicia".to_string()),
        FacadeErrorCode::Core(ClientErrorCode::NotReady),
    );

    client.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(client.poll());
    assert_code(
        client.vote("5"),
        FacadeErrorCode::Core(ClientErrorCode::NotReady),
    );
    assert_code(
        client.reveal(),
        FacadeErrorCode::Core(ClientErrorCode::NotReady),
    );

    client.rename("Alicia".to_string()).unwrap();
    client.chat("before room".to_string()).unwrap();
    push(
        &transport,
        TransportEvent::Text(room_payload("PLAYING", "", "", false)),
    );
    assert!(client.poll());

    let revision = client.snapshot().unwrap().revision;
    client.vote("5").unwrap();
    assert_eq!(client.snapshot().unwrap().revision, revision + 1);
    client.vote("5").unwrap();
    assert_eq!(client.snapshot().unwrap().revision, revision + 1);
    client.retract_vote().unwrap();
    client.vote("?").unwrap();
    client.chat("hello".to_string()).unwrap();
    client.reveal().unwrap();

    push(
        &transport,
        TransportEvent::Text(room_payload("CARDS_REVEALED", "?", "5", true)),
    );
    assert!(client.poll());
    assert_eq!(
        client.snapshot().unwrap().history[0].own_vote,
        Some(VoteData::Special("?".to_string()))
    );
    client.start_new_round().unwrap();

    assert_eq!(
        transport.borrow().sent,
        [
            r#"{"requestType":"ChangeName","name":"Alicia"}"#,
            r#"{"requestType":"ChatMessage","message":"before room"}"#,
            r#"{"requestType":"PlayCard","cardValue":"5"}"#,
            r#"{"requestType":"PlayCard","cardValue":"5"}"#,
            r#"{"requestType":"PlayCard","cardValue":null}"#,
            r#"{"requestType":"PlayCard","cardValue":"?"}"#,
            r#"{"requestType":"ChatMessage","message":"hello"}"#,
            r#"{"requestType":"RevealCards"}"#,
            r#"{"requestType":"StartNewRound"}"#,
        ]
    );
    assert_eq!(client.snapshot().unwrap().local_vote, None);
}

#[test]
fn invalid_votes_are_core_activity_and_absent_averages_are_null() {
    let (mut client, _, _, transport) = facade(ConnectionRole::Participant);
    client.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    push(
        &transport,
        TransportEvent::Text(room_payload("PLAYING", "", "", false)),
    );
    assert!(client.poll());

    let revision = client.snapshot().unwrap().revision;
    client.vote("not-in-deck").unwrap();
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot.revision, revision + 1);
    assert_eq!(snapshot.log.last().unwrap().source, LogSource::Client);
    assert_eq!(snapshot.log.last().unwrap().level, LogLevel::Error);
    assert!(transport.borrow().sent.is_empty());

    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["average"], Value::Null);
    assert_eq!(value["terminalError"], Value::Null);
    assert_eq!(value["localVote"], Value::Null);
}

#[test]
fn close_is_idempotent_readable_and_terminal_for_every_command() {
    let (mut client, _, factory, transport) = facade(ConnectionRole::Participant);
    client.connect().unwrap();
    let revision = client.snapshot().unwrap().revision;

    client.close();
    client.close();

    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot.status, ConnectionStatus::Closed);
    assert_eq!(snapshot.revision, revision + 1);
    assert!(!client.poll());
    assert_eq!(transport.borrow().closes, 1);
    assert_eq!(factory.borrow().urls.len(), 1);
    let closed = FacadeErrorCode::Core(ClientErrorCode::Closed);
    assert_eq!(client.connect().unwrap_err().code, closed);
    assert_code(client.vote("5"), closed);
    assert_code(client.retract_vote(), closed);
    assert_code(client.rename("Closed".to_string()), closed);
    assert_code(client.chat("Closed".to_string()), closed);
    assert_code(client.reveal(), closed);
    assert_code(client.start_new_round(), closed);
    assert_eq!(client.snapshot().unwrap().revision, revision + 1);
}

#[test]
fn asynchronous_and_synchronous_transport_failures_are_terminal_and_clean_once() {
    let (mut asynchronous, _, _, transport) = facade(ConnectionRole::Participant);
    asynchronous.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(asynchronous.poll());
    push(
        &transport,
        TransportEvent::Error("network failed".to_string()),
    );
    assert!(asynchronous.poll());
    let failed = asynchronous.snapshot().unwrap();
    assert_eq!(failed.status, ConnectionStatus::Closed);
    assert_eq!(
        failed.terminal_error.unwrap().code,
        ClientErrorCode::Transport
    );
    assert_eq!(transport.borrow().closes, 1);
    asynchronous.close();
    assert_eq!(transport.borrow().closes, 1);
    assert!(!asynchronous.poll());

    let (mut synchronous, _, factory, transport) = facade(ConnectionRole::Spectator);
    factory.borrow_mut().error = Some("SecurityError".to_string());
    let error = synchronous.connect().unwrap_err();
    assert_eq!(
        error.code,
        FacadeErrorCode::Core(ClientErrorCode::Transport)
    );
    assert_eq!(error.message, "WebSocket connection could not be created.");
    assert_eq!(error.details, None);
    let failed = synchronous.snapshot().unwrap();
    assert_eq!(failed.status, ConnectionStatus::Closed);
    assert_eq!(failed.revision, 1);
    assert_eq!(
        failed.terminal_error.unwrap().code,
        ClientErrorCode::Transport
    );
    assert_eq!(transport.borrow().closes, 0);
}

#[test]
fn protocol_and_remote_close_events_are_terminal_and_commit_once() {
    let (mut malformed, _, _, malformed_transport) = facade(ConnectionRole::Participant);
    malformed.connect().unwrap();
    push(&malformed_transport, TransportEvent::Opened);
    push(
        &malformed_transport,
        TransportEvent::Text("not json".to_string()),
    );

    assert!(malformed.poll());
    let snapshot = malformed.snapshot().unwrap();
    assert_eq!(snapshot.status, ConnectionStatus::Closed);
    assert_eq!(snapshot.revision, 2);
    assert_eq!(
        snapshot.terminal_error.unwrap().code,
        ClientErrorCode::Protocol
    );
    assert_eq!(malformed_transport.borrow().closes, 1);
    assert!(!malformed.poll());

    let (mut remote_close, _, _, close_transport) = facade(ConnectionRole::Spectator);
    remote_close.connect().unwrap();
    push(&close_transport, TransportEvent::Opened);
    push(&close_transport, TransportEvent::Closed);

    assert!(remote_close.poll());
    let snapshot = remote_close.snapshot().unwrap();
    assert_eq!(snapshot.status, ConnectionStatus::Closed);
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.terminal_error, None);
    assert_eq!(close_transport.borrow().closes, 1);
    remote_close.close();
    assert_eq!(remote_close.snapshot().unwrap().revision, 2);
    assert_eq!(close_transport.borrow().closes, 1);
}

#[test]
fn send_failures_commit_terminal_state_and_local_mutation_once() {
    let (mut client, _, _, transport) = facade(ConnectionRole::Participant);
    client.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(client.poll());
    transport.borrow_mut().send_error = Some("send failed".to_string());
    let revision = client.snapshot().unwrap().revision;

    let error = client.rename("Alicia".to_string()).unwrap_err();

    assert_eq!(
        error.code,
        FacadeErrorCode::Core(ClientErrorCode::Transport)
    );
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot.status, ConnectionStatus::Closed);
    assert_eq!(snapshot.local_name, "Alicia");
    assert_eq!(snapshot.revision, revision + 1);
    assert_eq!(snapshot.terminal_error.unwrap().message, "send failed");
    assert_eq!(transport.borrow().closes, 1);
}

#[test]
fn errors_and_numeric_boundaries_have_stable_safe_shapes() {
    for core in [
        ClientErrorCode::NotReady,
        ClientErrorCode::Closed,
        ClientErrorCode::Transport,
        ClientErrorCode::Protocol,
    ] {
        let facade = FacadeErrorCode::Core(core);
        assert_eq!(facade.as_str(), format!("{core:?}"));
    }

    assert_eq!(duration_ms(Duration::from_millis(42)).unwrap(), 42.0);
    assert_eq!(finite_average(None).unwrap(), None);
    assert_eq!(finite_average(Some(4.5)).unwrap(), Some(4.5));
    assert_eq!(
        finite_average(Some(f32::NAN)).unwrap_err().code,
        FacadeErrorCode::Core(ClientErrorCode::Protocol)
    );
    let unsafe_duration = Duration::from_millis((MAX_SAFE_INTEGER + 1) as u64);
    assert_eq!(
        duration_ms(unsafe_duration).unwrap_err().code,
        FacadeErrorCode::Core(ClientErrorCode::Protocol)
    );

    let error = ClientError {
        code: ClientErrorCode::Protocol,
        message: "invalid".to_string(),
    };
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        serde_json::json!({
            "code": "Protocol",
            "message": "invalid"
        })
    );
}

#[test]
fn every_core_model_variant_is_structured() {
    let snapshot = decode_room_snapshot(
        &serde_json::json!({
            "roomId": "variants",
            "deck": ["1", "?"],
            "gamePhase": "FUTURE_PHASE",
            "users": [
                { "username": "missing", "userType": "PARTICIPANT", "yourUser": true, "cardValue": "" },
                { "username": "hidden", "userType": "PARTICIPANT", "yourUser": false, "cardValue": "✅" },
                { "username": "special", "userType": "PARTICIPANT", "yourUser": false, "cardValue": "?" }
            ],
            "average": "0",
            "log": []
        })
        .to_string(),
    )
    .unwrap();
    let mut session = Session::new("missing".to_string(), Rc::new(ManualClock::default()));
    session.apply_room_snapshot(snapshot);
    let room = session.room().unwrap();

    assert_eq!(room.phase, GamePhase::Unknown);
    assert_eq!(room.players[0].vote, Vote::Missing);
    assert_eq!(room.players[1].vote, Vote::Hidden);
    assert_eq!(
        room.players[2].vote,
        Vote::Revealed(VoteData::Special("?".to_string()))
    );
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
        LogLevel::DECL,
        LogSource::DECL,
        LogEntry::DECL,
        HistoryEntry::DECL,
        ClientSnapshot::DECL,
    ]
    .join("\n");

    for expected in [
        "export type ConnectionRole",
        "export interface ClientOptions",
        "endpoint: string",
        "role: ConnectionRole",
        "export type Vote",
        "export interface Room",
        "export interface ClientSnapshot",
        "revision: number",
        "terminalError: ClientError | null",
        "room: Room | null",
        "average: number | null",
    ] {
        assert!(
            declarations.contains(expected),
            "missing `{expected}` from generated declarations:\n{declarations}"
        );
    }
    for forbidden in ["any", "bigint", "undefined"] {
        assert!(
            !declarations.contains(forbidden),
            "generated declarations contain `{forbidden}`:\n{declarations}"
        );
    }
}
