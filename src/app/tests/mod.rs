use super::*;
use crate::models::VoteData;
use crate::notification::MockNotificationHandler;
use crate::web::client::NativeClock;
use mockall::predicate::*;
use ppoker_core::client::ConnectionStatus;
use std::cell::Cell;
use std::time::Duration;

struct RecordingNotification(Cell<bool>);

impl NotificationHandler for RecordingNotification {
    fn notify(&self, _summary: &str, _body: &str) {
        self.0.set(true);
    }
}

struct InjectableTransport {
    inner: Box<dyn Transport>,
    updates: Rc<RefCell<InjectedTransportState>>,
}

impl Transport for InjectableTransport {
    fn poll_event(&mut self) -> Option<TransportEvent> {
        let mut updates = self.updates.borrow_mut();
        if updates.active {
            if let Some(event) = updates.events.pop_front() {
                return Some(event);
            }
            updates.active = false;
            return None;
        }
        if let Some(event) = updates.events.pop_front() {
            updates.active = true;
            return Some(event);
        }
        drop(updates);
        self.inner.poll_event()
    }

    fn send_text(&mut self, message: String) -> Result<(), String> {
        self.inner.send_text(message)
    }

    fn close(&mut self) {
        self.inner.close();
    }
}

#[derive(Default)]
struct TestTransportState {
    events: VecDeque<TransportEvent>,
    sent: Vec<String>,
    send_error: Option<String>,
    closes: usize,
}

struct TestTransport(Rc<RefCell<TestTransportState>>);

impl Transport for TestTransport {
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

fn create_test_room() -> Room {
    create_test_room_with_deck(vec![
        "1".to_string(),
        "2".to_string(),
        "3".to_string(),
        "5".to_string(),
        "8".to_string(),
        "13".to_string(),
    ])
}

fn create_test_room_with_deck(deck: Vec<String>) -> Room {
    Room {
        name: "test-room".to_string(),
        deck,
        phase: GamePhase::Playing,
        players: vec![Player {
            name: "Test User".to_string(),
            vote: Vote::Missing,
            is_you: true,
            user_type: UserType::Player,
        }],
    }
}

fn recording_transport_with_events(
    events: impl IntoIterator<Item = TransportEvent>,
) -> (Box<dyn Transport>, Rc<RefCell<TestTransportState>>) {
    let state = Rc::new(RefCell::new(TestTransportState {
        events: events.into_iter().collect(),
        ..TestTransportState::default()
    }));
    (Box::new(TestTransport(state.clone())), state)
}

fn recording_transport() -> (Box<dyn Transport>, Rc<RefCell<TestTransportState>>) {
    recording_transport_with_events([])
}

pub fn create_test_app(transport: Box<dyn Transport>) -> App {
    create_test_app_with_startup_events(
        transport,
        [TransportEvent::Opened, test_room_event(create_test_room())],
    )
}

fn create_test_app_with_startup_events(
    transport: Box<dyn Transport>,
    events: impl IntoIterator<Item = TransportEvent>,
) -> App {
    let config = Config {
        server: "wss://mocked".to_owned(),
        name: "test".to_owned(),
        room: "test-room".to_owned(),
        ..Config::default()
    };
    let client_updates = Rc::new(RefCell::new(InjectedTransportState {
        events: events.into_iter().collect(),
        ..InjectedTransportState::default()
    }));
    let transport = InjectableTransport {
        inner: transport,
        updates: client_updates.clone(),
    };
    let mut client = Client::new(config.name.clone(), Rc::new(NativeClock::new()));
    client.connect(Box::new(transport)).unwrap();
    client.poll_next_room().unwrap();
    client_updates.borrow_mut().active = false;
    let mut app = App::from_client(config, client);
    app.client_updates = Some(client_updates);
    app
}

fn create_recording_app() -> (App, Rc<RefCell<TestTransportState>>) {
    let (transport, state) = recording_transport();
    (create_test_app(transport), state)
}

fn add_test_player(app: &mut App, player: Player) {
    let mut room = app.room().clone();
    room.players.push(player);
    app.set_room_for_test(room);
}

fn confirm_local_vote(app: &mut App, vote: VoteData) {
    let mut room = app.room().clone();
    room.players
        .iter_mut()
        .find(|player| player.is_you)
        .expect("test room has a local player")
        .vote = Vote::Revealed(vote);
    app.merge_update(room);
}

fn player(name: &str, vote: Vote, user_type: UserType) -> Player {
    Player {
        name: name.to_string(),
        vote,
        is_you: false,
        user_type,
    }
}

fn arm_auto_reveal(app: &mut App) {
    add_test_player(app, player("Other Player", Vote::Hidden, UserType::Player));
    app.vote("5").unwrap();
    assert!(app.auto_reveal_at.is_none());
    confirm_local_vote(app, VoteData::Number(5));
    assert!(app.auto_reveal_at.is_some());
}

#[test]
fn batched_room_updates_keep_native_timing_aligned() -> AppResult<()> {
    let (mut app, state) = create_recording_app();
    let mut revealed = create_test_room();
    revealed.phase = GamePhase::Revealed;
    revealed.players[0].vote = Vote::Revealed(VoteData::Number(5));
    let playing = create_test_room();
    state
        .borrow_mut()
        .events
        .extend([test_room_event(revealed), test_room_event(playing)]);

    app.update()?;

    assert!(matches!(app.history_durations.as_slice(), [Some(_)]));
    assert_eq!(app.history_durations.len(), app.history().len());
    assert!(app.round_started_at.is_some());

    Ok(())
}

#[test]
fn reveal_errors_preserve_or_cancel_auto_reveal_at_the_command_boundary() {
    for (case, timer_survives) in [("not ready", true), ("closed", true), ("send", false)] {
        let (mut app, state) = if case == "not ready" {
            let (transport, state) = recording_transport();
            let app = create_test_app_with_startup_events(
                transport,
                [test_room_event(create_test_room())],
            );
            assert_eq!(app.client.status(), ConnectionStatus::Connecting);
            (app, state)
        } else {
            create_recording_app()
        };
        match case {
            "closed" => {
                app.client.close();
            }
            "send" => state.borrow_mut().send_error = Some("send failed".to_string()),
            _ => {}
        }
        let timer = Instant::now() + Duration::from_secs(3);
        app.auto_reveal_at = Some(timer);

        assert!(app.reveal().is_err(), "{case}");
        assert_eq!(
            app.auto_reveal_at,
            timer_survives.then_some(timer),
            "{case}"
        );
    }
}

#[test]
fn autoreveal_confirmation_covers_voters_spectators_and_disabled_config() -> AppResult<()> {
    for (case, other_vote, spectator, disabled, should_arm) in [
        ("confirmed", Vote::Hidden, false, false, true),
        ("other missing", Vote::Missing, false, false, false),
        ("spectator missing", Vote::Hidden, true, false, true),
        ("disabled", Vote::Hidden, false, true, false),
    ] {
        let (mut app, state) = create_recording_app();
        add_test_player(
            &mut app,
            player("Other Player", other_vote, UserType::Player),
        );
        if spectator {
            add_test_player(
                &mut app,
                player("Spectator", Vote::Missing, UserType::Spectator),
            );
        }
        app.config.disable_auto_reveal = disabled;
        app.vote("5")?;
        assert!(app.auto_reveal_at.is_none(), "{case} before confirmation");
        confirm_local_vote(&mut app, VoteData::Number(5));
        assert_eq!(app.auto_reveal_at.is_some(), should_arm, "{case}");

        if should_arm {
            let sent = state.borrow().sent.len();
            app.check_auto_reveal()?;
            assert_eq!(state.borrow().sent.len(), sent, "{case}");
            app.auto_reveal_at = Some(Instant::now() - Duration::from_secs(1));
            app.check_auto_reveal()?;
            assert_eq!(
                state.borrow().sent.last().map(String::as_str),
                Some(r#"{"requestType":"RevealCards"}"#),
                "{case}"
            );
        }
    }
    Ok(())
}

#[test]
fn autoreveal_cancels_for_each_new_missing_voter_shape() {
    for cancellation in 0..3 {
        let (mut app, _) = create_recording_app();
        arm_auto_reveal(&mut app);
        let mut room = app.room().clone();
        match cancellation {
            0 => room
                .players
                .push(player("New Player", Vote::Missing, UserType::Player)),
            1 => room.players[1].vote = Vote::Missing,
            2 => room.players.push(player(
                "Unknown participant",
                Vote::Missing,
                UserType::Unknown,
            )),
            _ => unreachable!(),
        }

        app.merge_update(room);
        assert!(
            app.auto_reveal_at.is_none(),
            "cancellation case {cancellation}"
        );
    }
}

#[test]
fn native_vote_input_trims_matches_case_preserves_utf8_and_retracts() -> AppResult<()> {
    let (transport, state) = recording_transport();
    let mut app = create_test_app(transport);
    app.set_room_for_test(create_test_room_with_deck(vec![
        "coffee".to_string(),
        "☕".to_string(),
    ]));

    app.vote(" COFFEE ")?;
    app.vote("☕")?;
    app.vote(" - ")?;

    let values = state
        .borrow()
        .sent
        .iter()
        .map(|request| {
            serde_json::from_str::<serde_json::Value>(request).unwrap()["cardValue"].clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        values,
        [
            serde_json::json!("coffee"),
            serde_json::json!("☕"),
            serde_json::Value::Null
        ]
    );

    state.borrow_mut().send_error = Some("send failed".to_string());
    assert!(app.vote("coffee").is_err());
    assert!(!app
        .activity_log()
        .iter()
        .any(|entry| entry.message == "send failed"));

    Ok(())
}

#[test]
fn expected_command_errors_are_logged_without_propagating() {
    let (mut app, _) = create_recording_app();

    app.vote("not-a-card").unwrap();
    app.restart().unwrap();

    let errors = app
        .activity_log()
        .into_iter()
        .filter(|entry| entry.level == LogLevel::Error)
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0].message, "Card is not in the deck: not-a-card");
    assert_eq!(
        errors[1].message,
        "A new round can only be started after cards are revealed."
    );
}

#[test]
fn round_timing_is_app_owned_and_history_aligned() {
    let (mut app, state) = create_recording_app();
    app.round_started_at = Some(Instant::now() - Duration::from_millis(2500));
    let mut revealed = app.room().clone();
    revealed.phase = GamePhase::Revealed;
    revealed.players[0].vote = Vote::Revealed(VoteData::Number(5));
    state
        .borrow_mut()
        .events
        .push_back(test_room_event(revealed));

    app.update().unwrap();

    assert_eq!(app.history_durations.len(), app.history().len());
    assert!(app.history_durations[0].is_some());
    assert!(app.history_duration(0) >= Duration::from_millis(2500));
    assert_eq!(app.round_elapsed(), Duration::ZERO);
    assert_eq!(app.history_duration(1), Duration::ZERO);

    let mut revealed = create_test_room();
    revealed.phase = GamePhase::Revealed;
    let update = RoomTransition {
        previous_room: Some(create_test_room()),
        room: revealed,
        history_len: 1,
    };
    let mut no_start = None;
    let mut durations = vec![];
    App::merge_round_timing(&update, &mut no_start, &mut durations);
    assert_eq!(durations, [None]);
}

#[test]
fn every_initial_non_playing_room_starts_native_round_timer() {
    for phase in [GamePhase::Revealed, GamePhase::Unknown] {
        let (transport, _) = recording_transport();
        let mut room = create_test_room();
        room.phase = phase;
        let app = create_test_app_with_startup_events(
            transport,
            [TransportEvent::Opened, test_room_event(room)],
        );

        assert_eq!(app.room().phase, phase);
        assert!(app.history().is_empty());
        assert!(app.round_started_at.is_some());
        assert!(app.round_elapsed() < Duration::from_secs(1));
    }
}

#[test]
fn notification_is_table_driven_for_delivery_focus_and_disabled_config() -> AppResult<()> {
    let default_handler = RecordingNotification(Cell::new(false));
    default_handler.notify_with_bell("summary", "body");
    assert!(default_handler.0.get());

    for (case, has_focus, notifications_disabled, deliveries) in [
        ("background", false, false, 1),
        ("focused", true, false, 0),
        ("disabled", false, true, 0),
    ] {
        let (mut app, _) = create_recording_app();
        let mut notification = MockNotificationHandler::new();
        notification
            .expect_notify_with_bell()
            .with(
                eq("Planning Poker".to_string()),
                eq("Your vote is the last one missing.".to_string()),
            )
            .times(deliveries)
            .return_const(());
        app.notification_handler = Box::new(notification);
        app.has_focus = has_focus;
        app.config.disable_notifications = notifications_disabled;

        let mut room = app.room().clone();
        room.players.extend([
            player("Player 2", Vote::Missing, UserType::Player),
            player("Player 3", Vote::Missing, UserType::Player),
        ]);
        app.merge_update(room.clone());
        app.tick()?;
        assert!(app.notify_vote_at.is_none(), "{case}");
        assert!(!app.is_notified, "{case}");

        room.players[1].vote = Vote::Hidden;
        room.players[2].vote = Vote::Hidden;
        app.merge_update(room);
        assert!(app.notify_vote_at.is_some(), "{case}");
        assert!(!app.is_notified, "{case}");

        app.notify_vote_at = Some(Instant::now() - Duration::from_secs(1));
        app.tick()?;
        assert!(app.is_notified, "{case}");
        assert!(app.notify_vote_at.is_none(), "{case}");
    }

    Ok(())
}
