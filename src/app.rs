use log::{debug, info};
use ppoker_core::client::Session;
#[cfg(test)]
use ppoker_core::protocol::RoomSnapshot;
use std::error;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::models::{
    GamePhase, HistoryEntry, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};
use crate::notification::NotificationHandler;
use crate::web::client::{connect, NativeClock, PokerClient};

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

struct NativeLogEntry {
    position: usize,
    entry: LogEntry,
}

pub struct App {
    pub running: bool,
    session: Session,
    pub client: Box<dyn PokerClient>,
    native_log: Vec<NativeLogEntry>,
    native_log_position: usize,

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
        let (client, snapshot) = connect(&config)?;
        let client = Box::new(client);
        let mut session = Session::new(config.name.clone(), Rc::new(NativeClock::new()));
        session.apply_room_snapshot(snapshot);

        Ok(Self {
            running: true,
            session,
            client,
            native_log: vec![],
            native_log_position: 0,
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            auto_reveal_at: None,
            notification_handler: Box::new(crate::notification::create_notification_handler()),
            has_seen_changelog: false,
        })
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

    #[inline]
    fn is_my_vote_last_missing(&self) -> bool {
        Self::is_vote_last_missing(self.room())
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

    fn apply_native_room_effects(
        session: &Session,
        old: Option<Room>,
        native_log: &mut Vec<NativeLogEntry>,
        native_log_position: usize,
        is_notified: &mut bool,
        notify_vote_at: &mut Option<Instant>,
        has_updates: &mut bool,
        auto_reveal_at: &mut Option<Instant>,
    ) {
        let room = session
            .room()
            .expect("room effects follow an authoritative room snapshot");
        if let Some(old) = old {
            if old.phase != room.phase {
                if room.phase == GamePhase::Playing {
                    *is_notified = false;
                    *notify_vote_at = None;
                }
                *has_updates = true;
            }
        }

        if Self::is_vote_last_missing(room) {
            if !*is_notified && notify_vote_at.is_none() {
                Self::push_log_message(
                    native_log,
                    native_log_position,
                    session.now(),
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
                    .any(|p| p.user_type == UserType::Player && p.vote == Vote::Missing))
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
        debug!("room update: {:?}", update.room);
        let old = self.session.apply_room_snapshot(update);
        Self::apply_native_room_effects(
            &self.session,
            old,
            &mut self.native_log,
            self.native_log_position,
            &mut self.is_notified,
            &mut self.notify_vote_at,
            &mut self.has_updates,
            &mut self.auto_reveal_at,
        );
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let was_last_missing = self.is_my_vote_last_missing();
        self.session.vote(data, self.client.as_mut())?;

        if !self.config.disable_auto_reveal && was_last_missing && self.own_vote().is_some() {
            debug!("Starting auto-reveal timer.");
            self.auto_reveal_at = Some(Instant::now() + Duration::from_secs(3));
        }
        Ok(())
    }

    pub fn rename(&mut self, data: String) -> AppResult<()> {
        self.session.rename(data, self.client.as_mut())?;
        Ok(())
    }

    pub fn reveal(&mut self) -> AppResult<()> {
        self.client.ensure_ready()?;
        self.cancel_auto_reveal();
        self.session.reveal(self.client.as_mut())?;
        Ok(())
    }

    pub fn chat(&mut self, message: String) -> AppResult<()> {
        self.session.chat(message, self.client.as_mut())?;
        Ok(())
    }

    pub fn restart(&mut self) -> AppResult<()> {
        self.session.restart(self.client.as_mut())?;
        Ok(())
    }

    pub fn update(&mut self) -> AppResult<()> {
        let room_updates = self.client.get_updates()?;
        // TODO: reconnect?

        self.native_log_position = self.session.log().len();
        {
            let native_log_position = self.native_log_position;
            let native_log = &mut self.native_log;
            let is_notified = &mut self.is_notified;
            let notify_vote_at = &mut self.notify_vote_at;
            let has_updates = &mut self.has_updates;
            let auto_reveal_at = &mut self.auto_reveal_at;
            let room_updates = room_updates.into_iter().inspect(|update| {
                debug!("room update: {:?}", update.room);
            });
            self.session.apply_poll_batch(room_updates, |session, old| {
                Self::apply_native_room_effects(
                    session,
                    old,
                    native_log,
                    native_log_position,
                    is_notified,
                    notify_vote_at,
                    has_updates,
                    auto_reveal_at,
                );
            });
        }
        self.native_log_position = self.session.log().len();

        Ok(())
    }

    pub fn room(&self) -> &Room {
        self.session
            .room()
            .expect("native App is created after its initial room snapshot")
    }

    #[cfg(test)]
    pub fn set_room_for_test(&mut self, room: Room) {
        self.session
            .apply_room_snapshot(RoomSnapshot { room, log: vec![] });
    }

    pub fn own_vote(&self) -> &Option<VoteData> {
        self.session.own_vote()
    }

    pub fn name(&self) -> &str {
        self.session.name()
    }

    pub fn history(&self) -> &[HistoryEntry] {
        self.session.history()
    }

    pub fn round_number(&self) -> u32 {
        self.session.round_number()
    }

    pub fn round_elapsed(&self) -> Duration {
        self.session.round_elapsed().unwrap_or_default()
    }

    pub fn activity_log(&self) -> Vec<&LogEntry> {
        let log = self.session.log();
        let mut result = Vec::with_capacity(log.len() + self.native_log.len());
        for position in 0..=log.len() {
            result.extend(
                self.native_log
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
        native_log: &mut Vec<NativeLogEntry>,
        position: usize,
        timestamp: Duration,
        level: LogLevel,
        message: String,
    ) {
        native_log.push(NativeLogEntry {
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

    pub fn average_votes(&self) -> f32 {
        self.session.average_votes().unwrap_or(f32::NAN)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::models::VoteData;
    use crate::notification::create_notification_handler;
    use crate::notification::MockNotificationHandler;
    use mockall::predicate::*;
    use ppoker_core::client::{ClientError, ClientErrorCode, ClientResult, PokerClient};
    use std::time::Duration;

    mockall::mock! {
        pub PokerClient {}

        impl PokerClient for PokerClient {
            fn ensure_ready(&self) -> ClientResult<()>;
            fn get_updates(&mut self) -> ClientResult<Vec<RoomSnapshot>>;
            fn vote<'a>(&mut self, card_value: Option<&'a str>) -> ClientResult<()>;
            fn change_name(&mut self, name: &str) -> ClientResult<()>;
            fn chat(&mut self, message: &str) -> ClientResult<()>;
            fn reveal(&mut self) -> ClientResult<()>;
            fn reset(&mut self) -> ClientResult<()>;
            fn close(&mut self);
        }
    }

    fn create_mock_client() -> MockPokerClient {
        let mut client = MockPokerClient::new();
        client.expect_ensure_ready().returning(|| Ok(()));
        client
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

    pub fn create_test_app(mock_client: Box<dyn PokerClient>) -> App {
        let mut config = Config::default();
        config.server = "wss://mocked".to_owned();
        config.name = "test".to_owned();
        config.room = "test-room".to_owned();
        let mut session = Session::new("Test User".to_string(), Rc::new(NativeClock::new()));
        session.apply_room_snapshot(RoomSnapshot {
            room: create_test_room(),
            log: vec![],
        });
        App {
            running: true,
            session,
            client: mock_client,
            native_log: vec![],
            native_log_position: 0,
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            auto_reveal_at: None,
            notification_handler: Box::new(create_notification_handler()),
            has_seen_changelog: false,
        }
    }

    fn add_test_player(app: &mut App, player: Player) {
        let mut room = app.room().clone();
        room.players.push(player);
        app.set_room_for_test(room);
    }

    #[test]
    fn test_vote_success() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        app.vote("5")?;
        assert!(app.own_vote().is_some());
        if let Some(VoteData::Number(n)) = app.own_vote() {
            assert_eq!(*n, 5);
        } else {
            panic!("Expected numeric vote");
        }

        Ok(())
    }

    #[test]
    fn test_update_merges_room_data() -> AppResult<()> {
        let mut mock_client = create_mock_client();

        // Set up the mock to return a room update
        let mut updated_room = create_test_room();
        updated_room.phase = GamePhase::Revealed;
        updated_room.players[0].vote = Vote::Revealed(VoteData::Number(5));

        mock_client
            .expect_get_updates()
            .times(1)
            .return_once(move || {
                Ok(vec![RoomSnapshot {
                    room: updated_room,
                    log: vec![],
                }])
            });

        let mut app = create_test_app(Box::new(mock_client));

        // Initial state checks
        assert_eq!(app.room().phase, GamePhase::Playing);
        assert_eq!(app.room().players[0].vote, Vote::Missing);
        assert!(app.history().is_empty());

        // Perform update
        app.update()?;

        // Verify state changes
        assert_eq!(app.room().phase, GamePhase::Revealed);
        assert_eq!(
            app.room().players[0].vote,
            Vote::Revealed(VoteData::Number(5))
        );
        assert_eq!(app.history().len(), 1);
        assert_eq!(app.history()[0].round_number, 1);
        assert_eq!(app.history()[0].votes.len(), 1);
        assert_eq!(
            app.history()[0].votes[0].vote,
            Vote::Revealed(VoteData::Number(5))
        );

        Ok(())
    }

    #[test]
    fn test_update_commits_one_revision_for_multiple_room_snapshots() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        let mut revealed = create_test_room();
        revealed.phase = GamePhase::Revealed;
        revealed.players[0].vote = Vote::Revealed(VoteData::Number(5));
        let playing = create_test_room();
        mock_client
            .expect_get_updates()
            .times(1)
            .return_once(move || {
                Ok(vec![
                    RoomSnapshot {
                        room: revealed,
                        log: vec![],
                    },
                    RoomSnapshot {
                        room: playing,
                        log: vec![],
                    },
                ])
            });

        let mut app = create_test_app(Box::new(mock_client));
        let revision = app.session.revision();
        app.update()?;

        assert_eq!(app.session.revision(), revision + 1);
        assert_eq!(app.room().phase, GamePhase::Playing);
        assert_eq!(app.history().len(), 1);
        assert_eq!(app.round_number(), 2);
        Ok(())
    }

    #[test]
    fn test_chat_message() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_chat()
            .withf(|msg: &str| msg == "Hello!")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));
        app.chat("Hello!".to_string())?;

        Ok(())
    }

    #[test]
    fn test_reveal_not_ready_preserves_auto_reveal_timer() {
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_ensure_ready()
            .times(1)
            .returning(|| Err(ClientError::not_ready("not ready")));
        let mut app = create_test_app(Box::new(mock_client));
        let timer = Instant::now() + Duration::from_secs(3);
        app.auto_reveal_at = Some(timer);

        assert!(app.reveal().is_err());
        assert_eq!(app.auto_reveal_at, Some(timer));
    }

    #[test]
    fn test_reveal_closed_preserves_auto_reveal_timer() {
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_ensure_ready()
            .times(1)
            .returning(|| Err(ClientError::closed("closed")));
        let mut app = create_test_app(Box::new(mock_client));
        let timer = Instant::now() + Duration::from_secs(3);
        app.auto_reveal_at = Some(timer);

        assert!(app.reveal().is_err());
        assert_eq!(app.auto_reveal_at, Some(timer));
    }

    #[test]
    fn test_reveal_send_failure_keeps_auto_reveal_cancelled() {
        let mut mock_client = create_mock_client();
        mock_client.expect_reveal().times(1).returning(|| {
            Err(ClientError {
                code: ClientErrorCode::Transport,
                message: "send failed".to_string(),
            })
        });
        let mut app = create_test_app(Box::new(mock_client));
        app.auto_reveal_at = Some(Instant::now() + Duration::from_secs(3));

        assert!(app.reveal().is_err());
        assert!(app.auto_reveal_at.is_none());
    }

    #[test]
    fn test_autoreveal_triggers_when_last_to_vote() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        // Expect vote to be called first
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        // Expect reveal to be called after 3 seconds
        mock_client.expect_reveal().times(1).returning(|| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who has already voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Hidden,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Fast forward time and trigger the auto-reveal
        app.auto_reveal_at = Some(Instant::now() - Duration::from_secs(1));
        app.check_auto_reveal()?;

        Ok(())
    }

    #[test]
    fn test_autoreveal_not_triggered_when_others_not_voted() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who hasn't voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Missing,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Cast our vote
        app.vote("5")?;

        // Verify auto-reveal timer is not set since we're not last
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }

    #[test]
    fn test_autoreveal_not_affected_by_spectators() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        mock_client.expect_reveal().times(1).returning(|| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who has voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Hidden,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Add a spectator
        add_test_player(
            &mut app,
            Player {
                name: "Spectator".to_string(),
                vote: Vote::Missing,
                is_you: false,
                user_type: UserType::Spectator,
            },
        );

        // Cast our vote as the last player (spectator doesn't count)
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Fast forward time and trigger the auto-reveal
        app.auto_reveal_at = Some(Instant::now() - Duration::from_secs(1));
        app.check_auto_reveal()?;

        Ok(())
    }

    #[test]
    fn test_autoreveal_respects_config_disable() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who has voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Hidden,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Disable auto-reveal in config
        app.config.disable_auto_reveal = true;

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is not set due to config
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }

    #[test]
    fn test_autoreveal_cancels_when_new_player_joins() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who has voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Hidden,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Create updated room state with new player
        let mut updated_room = app.room().clone();
        updated_room.players.push(Player {
            name: "New Player".to_string(),
            vote: Vote::Missing,
            is_you: false,
            user_type: UserType::Player,
        });

        // Merge the room update
        app.merge_update(updated_room);

        // Verify auto-reveal was cancelled
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }

    #[test]
    fn test_autoreveal_cancels_when_vote_retracted() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Add another player who has voted
        add_test_player(
            &mut app,
            Player {
                name: "Other Player".to_string(),
                vote: Vote::Hidden,
                is_you: false,
                user_type: UserType::Player,
            },
        );

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Create updated room state with retracted vote
        let mut updated_room = app.room().clone();
        updated_room.players[1].vote = Vote::Missing;

        // Merge the room update
        app.merge_update(updated_room);

        // Verify auto-reveal was cancelled
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }

    #[test]
    fn test_vote_with_special_values() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "coffee")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app_with_special_deck(mock_client);

        app.vote("coffee")?;
        assert!(app.own_vote().is_some());
        if let Some(VoteData::Special(value)) = app.own_vote() {
            assert_eq!(value, "coffee");
        } else {
            panic!("Expected special vote");
        }

        Ok(())
    }

    #[test]
    fn test_vote_with_utf8_values() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "☕")
            .times(1)
            .returning(|_| Ok(()));

        let deck = vec!["1".to_string(), "☕".to_string(), "🎲".to_string()];
        let mut app = create_test_app(Box::new(mock_client));
        app.set_room_for_test(create_test_room_with_deck(deck));

        app.vote("☕")?;
        assert!(app.own_vote().is_some());
        if let Some(VoteData::Special(value)) = app.own_vote() {
            assert_eq!(value, "☕");
        } else {
            panic!("Expected special vote with UTF-8 character");
        }

        Ok(())
    }

    #[test]
    fn test_vote_retraction() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| *x == Some("5"))
            .times(1)
            .returning(|_| Ok(()));
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.is_none())
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        // Set initial vote
        app.vote("5")?;

        // Retract vote using "-"
        app.vote("-")?;

        assert!(app.own_vote().is_none());

        Ok(())
    }

    #[test]
    fn test_rename() -> AppResult<()> {
        let mut mock_client = create_mock_client();
        mock_client
            .expect_change_name()
            .withf(|name: &str| name == "New Name")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(Box::new(mock_client));

        app.rename("New Name".to_string())?;

        assert_eq!(app.name(), "New Name");

        Ok(())
    }

    fn create_test_app_with_special_deck(mock_client: MockPokerClient) -> App {
        let deck = vec!["1".to_string(), "coffee".to_string(), "?".to_string()];
        let mut app = create_test_app(Box::new(mock_client));
        app.set_room_for_test(create_test_room_with_deck(deck));
        app
    }

    pub fn expect_notification(mock: &mut MockNotificationHandler, summary: String, body: String) {
        mock.expect_notify_with_bell()
            .with(eq(summary), eq(body))
            .times(1)
            .return_const(());
    }

    #[test]
    fn test_notification_triggers_when_last_to_vote() -> AppResult<()> {
        let mock_client = MockPokerClient::new();
        let mut mock_notification = MockNotificationHandler::new();

        // Set up notification expectation before boxing the mock
        expect_notification(
            &mut mock_notification,
            "Planning Poker".to_string(),
            "Your vote is the last one missing.".to_string(),
        );

        let mut app = App {
            notification_handler: Box::new(mock_notification),
            has_focus: false, // Ensure notification can trigger
            config: Config {
                disable_notifications: false,
                ..Config::default()
            },
            ..create_test_app(Box::new(mock_client))
        };

        // First create a room with players who haven't voted yet
        let mut new_room = app.room().clone();
        new_room.players.push(Player {
            name: "Player 2".to_string(),
            vote: Vote::Missing,
            is_you: false,
            user_type: UserType::Player,
        });
        new_room.players.push(Player {
            name: "Player 3".to_string(),
            vote: Vote::Missing,
            is_you: false,
            user_type: UserType::Player,
        });

        // Merge the room with missing votes and verify no notification is scheduled
        app.merge_update(new_room.clone());
        app.tick()?;
        assert!(app.notify_vote_at.is_none());
        assert!(!app.is_notified);

        // Now update the room so other players have voted
        let mut voted_room = new_room.clone();
        voted_room.players[1].vote = Vote::Hidden;
        voted_room.players[2].vote = Vote::Hidden;

        // Merge the room with voted players and verify notification gets scheduled
        app.merge_update(voted_room);
        assert!(app.notify_vote_at.is_some());
        assert!(!app.is_notified);

        // Fast forward time past notification deadline
        app.notify_vote_at = Some(Instant::now() - Duration::from_secs(1));
        app.tick()?;

        // Verify notification was sent
        assert!(app.is_notified);
        assert!(app.notify_vote_at.is_none());

        Ok(())
    }
}
