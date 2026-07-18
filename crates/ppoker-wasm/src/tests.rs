use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use ppoker_core::client::TransportEvent;
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

fn options(role: ClientRole) -> ClientOptions {
    ClientOptions {
        endpoint: "wss://example.test/base/".to_string(),
        room: "planning / 東京".to_string(),
        name: "Alice & Bob".to_string(),
        role,
    }
}

fn facade(role: ClientRole) -> FacadeFixture {
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

fn assert_code(result: Result<(), FacadeError>, code: ErrorCode) {
    assert_eq!(result.unwrap_err().code, code);
}

#[test]
fn options_validate_with_shared_url_policy_and_both_roles() {
    for (role, user_type) in [
        (ClientRole::Participant, "PARTICIPANT"),
        (ClientRole::Spectator, "SPECTATOR"),
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
        let mut invalid = options(ClientRole::Participant);
        invalid.endpoint = endpoint.to_string();
        let error = ClientFacade::new(
            invalid,
            Rc::new(ManualClock::default()),
            Box::new(BrowserTransportFactory),
        )
        .err()
        .expect("endpoint should be rejected");
        assert_eq!(error.code, ErrorCode::InvalidOptions);
        assert_eq!(error.details.unwrap().field, "endpoint");
    }
}

#[test]
fn dot_room_options_fail_before_transport_construction() {
    for room in [".", ".."] {
        let factory = Rc::new(RefCell::new(FakeFactoryState::default()));
        let transport = Rc::new(RefCell::new(FakeTransportState::default()));
        let mut invalid = options(ClientRole::Participant);
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

        assert_eq!(error.code, ErrorCode::InvalidOptions);
        assert_eq!(error.message, "Room must not be `.` or `..`.");
        assert_eq!(
            error.details,
            Some(ErrorDetails {
                field: "room".to_string(),
                reason: "Room must not be `.` or `..`.".to_string(),
            })
        );
        assert!(factory.borrow().urls.is_empty());
    }
}

#[test]
fn initial_snapshot_is_disconnected_structured_and_side_effect_free() {
    let (client, _, factory, _) = facade(ClientRole::Spectator);

    let snapshot = client.snapshot().unwrap();

    assert_eq!(snapshot.revision, 0);
    assert_eq!(snapshot.status, SnapshotStatus::Disconnected);
    assert_eq!(snapshot.terminal_error, None);
    assert_eq!(snapshot.room, None);
    assert_eq!(snapshot.local_name, "Alice & Bob");
    assert_eq!(snapshot.local_vote, None);
    assert!(snapshot.activity.is_empty());
    assert_eq!(snapshot.current_round.number, 0);
    assert_eq!(snapshot.current_round.started_at_ms, None);
    assert!(snapshot.history.is_empty());
    assert_eq!(snapshot.statistics.average, None);
    assert!(factory.borrow().urls.is_empty());
}

#[test]
fn polling_batches_status_room_history_activity_and_revision_once() {
    let (mut client, clock, _, transport) = facade(ClientRole::Participant);
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
    assert_eq!(playing.status, SnapshotStatus::Open);
    assert_eq!(playing.room.as_ref().unwrap().phase, PhaseSnapshot::Playing);
    assert_eq!(playing.room.as_ref().unwrap().players.len(), 3);
    assert_eq!(
        playing.room.as_ref().unwrap().players[1].role,
        PlayerRole::Spectator
    );
    assert_eq!(
        playing.room.as_ref().unwrap().players[2].role,
        PlayerRole::Unknown
    );
    assert_eq!(playing.activity.len(), 3);
    assert_eq!(playing.activity[0].level, ActivityLevel::Info);
    assert_eq!(playing.activity[1].level, ActivityLevel::Chat);
    assert_eq!(playing.activity[2].level, ActivityLevel::Error);
    assert_eq!(playing.activity[0].source, ActivitySource::Server);
    assert_eq!(playing.current_round.started_at_ms, Some(0.0));
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
    assert_eq!(revealed.statistics.average, Some(4.0));
    assert_eq!(revealed.history.len(), 1);
    assert_eq!(revealed.history[0].average, Some(4.0));
    assert_eq!(revealed.history[0].duration_ms, 2500.0);
    assert_eq!(revealed.history[0].votes.len(), 3);
    assert_eq!(
        revealed.room.unwrap().players[0].vote,
        VoteSnapshot::Revealed {
            value: VoteValueSnapshot::Number { value: 3 }
        }
    );

    clock.advance(Duration::from_secs(30));
    assert_eq!(client.snapshot().unwrap().revision, 3);
}

#[test]
fn all_commands_delegate_to_core_policy_and_update_only_visible_state() {
    let (mut client, _, _, transport) = facade(ClientRole::Spectator);
    assert_code(client.vote("5"), ErrorCode::NotReady);
    assert_code(client.rename("Alicia".to_string()), ErrorCode::NotReady);

    client.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(client.poll());
    assert_code(client.vote("5"), ErrorCode::NotReady);
    assert_code(client.reveal(), ErrorCode::NotReady);

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
        client.snapshot().unwrap().history[0].local_vote,
        Some(VoteValueSnapshot::Special {
            value: "?".to_string()
        })
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
    let (mut client, _, _, transport) = facade(ClientRole::Participant);
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
    assert_eq!(
        snapshot.activity.last().unwrap().source,
        ActivitySource::Client
    );
    assert_eq!(
        snapshot.activity.last().unwrap().level,
        ActivityLevel::Error
    );
    assert!(transport.borrow().sent.is_empty());

    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["statistics"]["average"], Value::Null);
    assert_eq!(value["terminalError"], Value::Null);
    assert_eq!(value["localVote"], Value::Null);
}

#[test]
fn close_is_idempotent_readable_and_terminal_for_every_command() {
    let (mut client, _, factory, transport) = facade(ClientRole::Participant);
    client.connect().unwrap();
    let revision = client.snapshot().unwrap().revision;

    client.close();
    client.close();

    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot.status, SnapshotStatus::Closed);
    assert_eq!(snapshot.revision, revision + 1);
    assert!(!client.poll());
    assert_eq!(transport.borrow().closes, 1);
    assert_eq!(factory.borrow().urls.len(), 1);
    assert_eq!(client.connect().unwrap_err().code, ErrorCode::Closed);
    assert_code(client.vote("5"), ErrorCode::Closed);
    assert_code(client.retract_vote(), ErrorCode::Closed);
    assert_code(client.rename("Closed".to_string()), ErrorCode::Closed);
    assert_code(client.chat("Closed".to_string()), ErrorCode::Closed);
    assert_code(client.reveal(), ErrorCode::Closed);
    assert_code(client.start_new_round(), ErrorCode::Closed);
    assert_eq!(client.snapshot().unwrap().revision, revision + 1);
}

#[test]
fn asynchronous_and_synchronous_transport_failures_are_terminal_and_clean_once() {
    let (mut asynchronous, _, _, transport) = facade(ClientRole::Participant);
    asynchronous.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(asynchronous.poll());
    push(
        &transport,
        TransportEvent::Error("network failed".to_string()),
    );
    assert!(asynchronous.poll());
    let failed = asynchronous.snapshot().unwrap();
    assert_eq!(failed.status, SnapshotStatus::Closed);
    assert_eq!(failed.terminal_error.unwrap().code, ErrorCode::Transport);
    assert_eq!(transport.borrow().closes, 1);
    asynchronous.close();
    assert_eq!(transport.borrow().closes, 1);
    assert!(!asynchronous.poll());

    let (mut synchronous, _, factory, transport) = facade(ClientRole::Spectator);
    factory.borrow_mut().error = Some("SecurityError".to_string());
    let error = synchronous.connect().unwrap_err();
    assert_eq!(error.code, ErrorCode::Transport);
    assert_eq!(error.message, "WebSocket connection could not be created.");
    assert_eq!(error.details.unwrap().reason, "SecurityError");
    let failed = synchronous.snapshot().unwrap();
    assert_eq!(failed.status, SnapshotStatus::Closed);
    assert_eq!(failed.revision, 1);
    assert_eq!(failed.terminal_error.unwrap().code, ErrorCode::Transport);
    assert_eq!(transport.borrow().closes, 0);
}

#[test]
fn protocol_and_remote_close_events_are_terminal_and_commit_once() {
    let (mut malformed, _, _, malformed_transport) = facade(ClientRole::Participant);
    malformed.connect().unwrap();
    push(&malformed_transport, TransportEvent::Opened);
    push(
        &malformed_transport,
        TransportEvent::Text("not json".to_string()),
    );

    assert!(malformed.poll());
    let snapshot = malformed.snapshot().unwrap();
    assert_eq!(snapshot.status, SnapshotStatus::Closed);
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.terminal_error.unwrap().code, ErrorCode::Protocol);
    assert_eq!(malformed_transport.borrow().closes, 1);
    assert!(!malformed.poll());

    let (mut remote_close, _, _, close_transport) = facade(ClientRole::Spectator);
    remote_close.connect().unwrap();
    push(&close_transport, TransportEvent::Opened);
    push(&close_transport, TransportEvent::Closed);

    assert!(remote_close.poll());
    let snapshot = remote_close.snapshot().unwrap();
    assert_eq!(snapshot.status, SnapshotStatus::Closed);
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.terminal_error, None);
    assert_eq!(close_transport.borrow().closes, 1);
    remote_close.close();
    assert_eq!(remote_close.snapshot().unwrap().revision, 2);
    assert_eq!(close_transport.borrow().closes, 1);
}

#[test]
fn send_failures_commit_terminal_state_and_local_mutation_once() {
    let (mut client, _, _, transport) = facade(ClientRole::Participant);
    client.connect().unwrap();
    push(&transport, TransportEvent::Opened);
    assert!(client.poll());
    transport.borrow_mut().send_error = Some("send failed".to_string());
    let revision = client.snapshot().unwrap().revision;

    let error = client.rename("Alicia".to_string()).unwrap_err();

    assert_eq!(error.code, ErrorCode::Transport);
    let snapshot = client.snapshot().unwrap();
    assert_eq!(snapshot.status, SnapshotStatus::Closed);
    assert_eq!(snapshot.local_name, "Alicia");
    assert_eq!(snapshot.revision, revision + 1);
    assert_eq!(snapshot.terminal_error.unwrap().message, "send failed");
    assert_eq!(transport.borrow().closes, 1);
}

#[test]
fn errors_and_numeric_projections_have_stable_safe_shapes() {
    for (core, facade) in [
        (ClientErrorCode::NotReady, ErrorCode::NotReady),
        (ClientErrorCode::Closed, ErrorCode::Closed),
        (ClientErrorCode::Transport, ErrorCode::Transport),
        (ClientErrorCode::Protocol, ErrorCode::Protocol),
    ] {
        assert_eq!(ErrorCode::from(core), facade);
        assert_eq!(facade.as_str(), format!("{facade:?}"));
    }

    assert_eq!(duration_ms(Duration::from_millis(42)).unwrap(), 42.0);
    assert_eq!(finite_average(None).unwrap(), None);
    assert_eq!(finite_average(Some(4.5)).unwrap(), Some(4.5));
    assert_eq!(
        finite_average(Some(f32::NAN)).unwrap_err().code,
        ErrorCode::Protocol
    );
    let unsafe_duration = Duration::from_millis((MAX_SAFE_INTEGER + 1) as u64);
    assert_eq!(
        duration_ms(unsafe_duration).unwrap_err().code,
        ErrorCode::Protocol
    );

    let details = ErrorDetails {
        field: "endpoint".to_string(),
        reason: "unsupported".to_string(),
    };
    let error = ClientErrorSnapshot {
        code: ErrorCode::InvalidOptions,
        message: "invalid".to_string(),
        details: Some(details),
    };
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        serde_json::json!({
            "code": "InvalidOptions",
            "message": "invalid",
            "details": { "field": "endpoint", "reason": "unsupported" }
        })
    );
}

#[test]
fn every_projection_variant_is_structured_without_native_values() {
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
    let room = room_snapshot(session.room().unwrap());

    assert_eq!(room.phase, PhaseSnapshot::Unknown);
    assert_eq!(room.players[0].vote, VoteSnapshot::Missing);
    assert_eq!(room.players[1].vote, VoteSnapshot::Hidden);
    assert_eq!(
        room.players[2].vote,
        VoteSnapshot::Revealed {
            value: VoteValueSnapshot::Special {
                value: "?".to_string()
            }
        }
    );
}

#[test]
fn generated_declarations_are_strongly_typed_and_match_null_runtime_values() {
    let declarations = [
        ClientRole::DECL,
        ClientOptions::DECL,
        SnapshotStatus::DECL,
        ErrorCode::DECL,
        ErrorDetails::DECL,
        ClientErrorSnapshot::DECL,
        PlayerRole::DECL,
        PhaseSnapshot::DECL,
        VoteValueSnapshot::DECL,
        VoteSnapshot::DECL,
        PlayerSnapshot::DECL,
        RoomSnapshot::DECL,
        ActivityLevel::DECL,
        ActivitySource::DECL,
        ActivitySnapshot::DECL,
        CurrentRoundSnapshot::DECL,
        HistorySnapshot::DECL,
        StatisticsSnapshot::DECL,
        ClientSnapshot::DECL,
    ]
    .join("\n");

    for expected in [
        "export type ClientRole",
        "export interface ClientOptions",
        "endpoint: string",
        "role: ClientRole",
        "export type VoteSnapshot",
        "export interface RoomSnapshot",
        "export interface ClientSnapshot",
        "revision: number",
        "terminalError: ClientErrorSnapshot | null",
        "room: RoomSnapshot | null",
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
