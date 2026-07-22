use log::{debug, info};
use ppoker_core::client::{Client, ClientErrorCode, ClientResult, ClientUpdate, RoomTransition};
#[cfg(test)]
use ppoker_core::client::{Transport, TransportEvent};
#[cfg(test)]
use ppoker_core::protocol::RoomSnapshot;
#[cfg(test)]
use std::cell::RefCell;
#[cfg(test)]
use std::collections::VecDeque;
use std::error;
#[cfg(test)]
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::models::{
    GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};
use crate::notification::NotificationHandler;
use crate::web::client::connect;

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

struct LocalLogEntry {
    position: usize,
    entry: LogEntry,
}

#[cfg(test)]
#[derive(Default)]
struct InjectedTransportState {
    events: VecDeque<TransportEvent>,
    active: bool,
}

pub struct App {
    pub running: bool,
    client: Client,
    #[cfg(test)]
    client_updates: Option<Rc<RefCell<InjectedTransportState>>>,
    local_log: Vec<LocalLogEntry>,
    local_log_position: usize,
    round_started_at: Option<Instant>,
    history_durations: Vec<Option<Duration>>,

    pub config: Config,

    pub has_focus: bool,
    notify_vote_at: Option<Instant>,
    is_notified: bool,
    pub has_updates: bool,

    pub auto_reveal_at: Option<Instant>,

    pub notification_handler: Box<dyn NotificationHandler>,
    pub has_seen_changelog: bool,
}

impl App {
    pub fn new(config: Config) -> AppResult<Self> {
        let client = connect(&config)?;

        Ok(Self::from_client(config, client))
    }

    pub(crate) fn from_client(config: Config, client: Client) -> Self {
        let round_started_at = client.room().map(|_| Instant::now());
        let history_durations = vec![None; client.history().len()];

        Self {
            running: true,
            client,
            #[cfg(test)]
            client_updates: None,
            local_log: vec![],
            local_log_position: 0,
            round_started_at,
            history_durations,
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            auto_reveal_at: None,
            notification_handler: Box::new(crate::notification::create_notification_handler()),
            has_seen_changelog: false,
        }
    }

    pub fn tick(&mut self) -> AppResult<()> {
        self.check_notification();
        self.check_auto_reveal()?;
        Ok(())
    }

    fn check_notification(&mut self) {
        if let Some(notify_at) = &self.notify_vote_at {
            if *notify_at < Instant::now() && !self.is_notified {
                if self.has_focus {
                    info!("Skipping notification because user has application focused.")
                } else {
                    if self.config.disable_notifications {
                        info!("Skipping notification because user has them disabled.");
                    } else {
                        info!("Notifying user of missing vote.");
                        self.notification_handler.notify_with_bell(
                            "Planning Poker",
                            "Your vote is the last one missing.",
                        );
                    }
                }
                self.is_notified = true;
                self.notify_vote_at = None;
            }
        }
    }

    fn check_auto_reveal(&mut self) -> AppResult<()> {
        if let Some(auto_reveal_at) = &self.auto_reveal_at {
            if *auto_reveal_at < Instant::now() {
                self.reveal()?;
            }
        }
        Ok(())
    }

    pub fn cancel_auto_reveal(&mut self) {
        self.auto_reveal_at = None;
    }

    fn is_vote_last_missing(room: &Room) -> bool {
        let missing_players = room
            .players
            .iter()
            .filter(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing)
            .collect::<Vec<&Player>>();
        room.players.len() > 1
            && missing_players.len() == 1
            && missing_players[0].is_you
            && room.phase == GamePhase::Playing
    }

    fn confirms_last_missing_vote(previous: &Room, room: &Room) -> bool {
        Self::is_vote_last_missing(previous)
            && room.phase == GamePhase::Playing
            && room.players.iter().any(|player| {
                player.is_you
                    && player.user_type != UserType::Spectator
                    && matches!(player.vote, Vote::Revealed(_))
            })
            && !room.players.iter().any(|player| {
                player.user_type != UserType::Spectator && player.vote == Vote::Missing
            })
    }

    fn merge_round_timing(
        update: &RoomTransition,
        round_started_at: &mut Option<Instant>,
        history_durations: &mut Vec<Option<Duration>>,
    ) {
        let now = Instant::now();
        let phase_changed = update
            .previous_room
            .as_ref()
            .is_some_and(|old| old.phase != update.room.phase);

        while history_durations.len() < update.history_len {
            let duration = if phase_changed && update.room.phase == GamePhase::Revealed {
                round_started_at
                    .take()
                    .map(|started_at| now.saturating_duration_since(started_at))
            } else {
                None
            };
            history_durations.push(duration);
        }

        if phase_changed && update.room.phase == GamePhase::Playing {
            *round_started_at = Some(now);
        }
    }

    fn handle_session_update(
        client: &Client,
        update: ClientUpdate,
        local_log: &mut Vec<LocalLogEntry>,
        local_log_position: usize,
        round_started_at: &mut Option<Instant>,
        history_durations: &mut Vec<Option<Duration>>,
        is_notified: &mut bool,
        notify_vote_at: &mut Option<Instant>,
        has_updates: &mut bool,
        auto_reveal_at: &mut Option<Instant>,
        disable_auto_reveal: bool,
    ) {
        let ClientUpdate::Room(update) = update;
        Self::merge_round_timing(&update, round_started_at, history_durations);

        let room = &update.room;
        if let Some(old) = update.previous_room.as_ref() {
            if old.phase != room.phase {
                if room.phase == GamePhase::Playing {
                    *is_notified = false;
                    *notify_vote_at = None;
                }
                *has_updates = true;
            }
            if !disable_auto_reveal && Self::confirms_last_missing_vote(old, room) {
                debug!("Starting auto-reveal timer.");
                *auto_reveal_at = Some(Instant::now() + Duration::from_secs(3));
            }
        }

        if Self::is_vote_last_missing(room) {
            if !*is_notified && notify_vote_at.is_none() {
                Self::push_log_message(
                    local_log,
                    local_log_position,
                    client.now(),
                    LogLevel::Info,
                    "Your vote is the last one missing.".to_string(),
                );
                *notify_vote_at = Some(Instant::now() + Duration::from_secs(8));
                *has_updates = true;
            }
        } else {
            *notify_vote_at = None;
        }

        if auto_reveal_at.is_some()
            && (room.phase != GamePhase::Playing
                || room
                    .players
                    .iter()
                    .any(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing))
        {
            debug!("Auto-reveal cancelled because of invalid state");
            *auto_reveal_at = None;
        }
    }

    #[cfg(test)]
    pub fn merge_update(&mut self, update: Room) {
        self.merge_snapshot(RoomSnapshot {
            room: update,
            log: vec![],
        });
    }

    #[cfg(test)]
    fn merge_snapshot(&mut self, update: RoomSnapshot) {
        self.queue_test_snapshot(update);
        self.update().expect("test client update should succeed");
    }

    #[cfg(test)]
    fn queue_test_snapshot(&self, update: RoomSnapshot) {
        self.client_updates
            .as_ref()
            .expect("test Apps have an injectable client transport")
            .borrow_mut()
            .events
            .push_back(test_snapshot_event(update));
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let data = data.trim();
        let result = if data == "-" {
            self.client.retract_vote()
        } else {
            let card = self
                .room()
                .deck
                .iter()
                .find(|card| card.as_str() == data)
                .or_else(|| {
                    self.room()
                        .deck
                        .iter()
                        .find(|card| card.eq_ignore_ascii_case(data))
                })
                .cloned()
                .unwrap_or_else(|| data.to_string());
            self.client.vote(&card)
        };
        self.handle_command_result(result)
    }

    pub fn rename(&mut self, data: String) -> AppResult<()> {
        self.client.rename(data)?;
        Ok(())
    }

    pub fn reveal(&mut self) -> AppResult<()> {
        self.client.ensure_ready()?;
        self.cancel_auto_reveal();
        self.client.reveal()?;
        Ok(())
    }

    pub fn chat(&mut self, message: String) -> AppResult<()> {
        self.client.chat(message)?;
        Ok(())
    }

    pub fn restart(&mut self) -> AppResult<()> {
        let result = self.client.restart();
        self.handle_command_result(result)
    }

    pub fn update(&mut self) -> AppResult<()> {
        self.local_log_position = self.client.log().len();
        let outcome = self.client.poll()?;
        {
            let local_log_position = self.local_log_position;
            let client = &self.client;
            let local_log = &mut self.local_log;
            let round_started_at = &mut self.round_started_at;
            let history_durations = &mut self.history_durations;
            let is_notified = &mut self.is_notified;
            let notify_vote_at = &mut self.notify_vote_at;
            let has_updates = &mut self.has_updates;
            let auto_reveal_at = &mut self.auto_reveal_at;
            let disable_auto_reveal = self.config.disable_auto_reveal;
            for update in outcome.updates {
                debug!("room update: {:?}", update);
                Self::handle_session_update(
                    client,
                    update,
                    local_log,
                    local_log_position,
                    round_started_at,
                    history_durations,
                    is_notified,
                    notify_vote_at,
                    has_updates,
                    auto_reveal_at,
                    disable_auto_reveal,
                );
            }
        }
        self.local_log_position = self.client.log().len();

        Ok(())
    }

    pub fn room(&self) -> &Room {
        self.client
            .room()
            .expect("native App is created after its initial room snapshot")
    }

    #[cfg(test)]
    pub fn set_room_for_test(&mut self, room: Room) {
        self.queue_test_snapshot(RoomSnapshot { room, log: vec![] });
        self.client
            .poll()
            .expect("test client update should succeed");
    }

    pub fn own_vote(&self) -> &Option<VoteData> {
        self.client.own_vote()
    }

    pub fn name(&self) -> &str {
        self.client.name()
    }

    pub fn history(&self) -> &[HistoryEntry] {
        self.client.history()
    }

    pub fn round_number(&self) -> u32 {
        self.client.round_number()
    }

    pub fn round_elapsed(&self) -> Duration {
        self.round_started_at
            .map(|started_at| started_at.elapsed())
            .unwrap_or_default()
    }

    pub fn history_duration(&self, index: usize) -> Duration {
        self.history_durations
            .get(index)
            .copied()
            .flatten()
            .unwrap_or_default()
    }

    pub fn activity_log(&self) -> Vec<&LogEntry> {
        let log = self.client.log();
        let mut result = Vec::with_capacity(log.len() + self.local_log.len());
        for position in 0..=log.len() {
            result.extend(
                self.local_log
                    .iter()
                    .filter(|entry| entry.position == position)
                    .map(|entry| &entry.entry),
            );
            if let Some(entry) = log.get(position) {
                result.push(entry);
            }
        }
        result
    }

    fn push_log_message(
        local_log: &mut Vec<LocalLogEntry>,
        position: usize,
        timestamp: Duration,
        level: LogLevel,
        message: String,
    ) {
        local_log.push(LocalLogEntry {
            position,
            entry: LogEntry {
                timestamp,
                level,
                message,
                source: LogSource::Client,
                server_index: None,
            },
        })
    }

    fn handle_command_result(&mut self, result: ClientResult<()>) -> AppResult<()> {
        match result {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.code,
                    ClientErrorCode::InvalidCard | ClientErrorCode::InvalidState
                ) =>
            {
                Self::push_log_message(
                    &mut self.local_log,
                    self.client.log().len(),
                    self.client.now(),
                    LogLevel::Error,
                    error.message,
                );
                Ok(())
            }
            Err(error) => Err(Box::new(error)),
        }
    }

    pub fn average_votes(&self) -> f32 {
        self.client.average_votes().unwrap_or(f32::NAN)
    }
}

#[cfg(test)]
pub(crate) fn encode_test_snapshot(snapshot: RoomSnapshot) -> String {
    let RoomSnapshot { room, log } = snapshot;
    let phase = match room.phase {
        GamePhase::Playing => "PLAYING",
        GamePhase::Revealed => "CARDS_REVEALED",
        GamePhase::Unknown => "FUTURE_PHASE",
    };
    let users = room
        .players
        .into_iter()
        .map(|player| {
            let user_type = match player.user_type {
                UserType::Player => "PARTICIPANT",
                UserType::Spectator => "SPECTATOR",
                UserType::Unknown => "FUTURE_TYPE",
            };
            let card_value = match player.vote {
                Vote::Missing => String::new(),
                Vote::Hidden => "✅".to_string(),
                Vote::Revealed(vote) => vote.to_string(),
            };
            serde_json::json!({
                "username": player.name,
                "userType": user_type,
                "yourUser": player.is_you,
                "cardValue": card_value,
            })
        })
        .collect::<Vec<_>>();
    let logs = log
        .iter()
        .map(|entry| {
            let level = match entry.level {
                LogLevel::Chat => "CHAT",
                LogLevel::Info => "INFO",
                LogLevel::Error => "ERROR",
            };
            serde_json::json!({ "level": level, "message": entry.message })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "roomId": room.name,
        "deck": room.deck,
        "gamePhase": phase,
        "users": users,
        "average": "0",
        "log": logs,
    })
    .to_string()
}

#[cfg(test)]
pub(crate) fn test_snapshot_event(snapshot: RoomSnapshot) -> TransportEvent {
    TransportEvent::Text(encode_test_snapshot(snapshot))
}

#[cfg(test)]
pub(crate) fn test_room_event(room: Room) -> TransportEvent {
    test_snapshot_event(RoomSnapshot { room, log: vec![] })
}

#[cfg(test)]
pub mod tests {
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
        let mut config = Config::default();
        config.server = "wss://mocked".to_owned();
        config.name = "test".to_owned();
        config.room = "test-room".to_owned();
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
}
