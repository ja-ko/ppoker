use crossterm::execute;
use crossterm::style::Print;
use log::{debug, info};
use std::time::{Duration, Instant};
use std::{error, io, mem};

use crate::config::Config;
use crate::models::{
    GamePhase, LogEntry, LogLevel, LogSource, Player, Room, UserType, Vote, VoteData,
};
use crate::notification::show_notification;
use crate::web::client::{PokerClient, WebPokerClient};

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

pub struct HistoryEntry {
    pub round_number: u32,
    pub average: f32,
    pub length: Duration,
    pub votes: Vec<Player>,
    pub deck: Vec<String>,
    pub own_vote: Option<VoteData>,
}

pub struct App {
    pub running: bool,
    pub vote: Option<VoteData>,
    pub name: String,

    pub room: Room,
    pub client: Box<dyn PokerClient>,
    pub log: Vec<LogEntry>,

    pub round_number: u32,
    pub round_start: Instant,

    pub config: Config,

    pub has_focus: bool,
    notify_vote_at: Option<Instant>,
    is_notified: bool,
    pub has_updates: bool,

    pub auto_reveal_at: Option<Instant>,

    pub history: Vec<HistoryEntry>,
}

impl App {
    pub fn new(config: Config) -> AppResult<Self> {
        let (client, room, log) = WebPokerClient::new(&config)?;
        let client = Box::new(client);

        let mut result = Self {
            running: true,
            vote: None,
            name: config.name.clone(),
            room,
            client,
            log: vec![],
            round_number: 1,
            round_start: Instant::now(),
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            history: vec![],
            auto_reveal_at: None,
        };
        result.update_server_log(log);

        Ok(result)
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
                        execute!(io::stdout(), Print("\x07")).unwrap();
                        show_notification();
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

    fn check_auto_reveal_cancel(&mut self) {
        if self.auto_reveal_at.is_some()
            && (self.room.phase != GamePhase::Playing
                || self
                    .room
                    .players
                    .iter()
                    .any(|p| p.user_type == UserType::Player && p.vote == Vote::Missing))
        {
            debug!("Auto-reveal cancelled because of invalid state");
            self.auto_reveal_at = None;
        }
    }

    pub fn cancel_auto_reveal(&mut self) {
        self.auto_reveal_at = None;
    }

    #[inline]
    fn deck_has_value(&self, vote: &str) -> bool {
        self.room
            .deck
            .iter()
            .find(|item| item.eq_ignore_ascii_case(vote))
            .is_some()
    }

    #[inline]
    fn is_my_vote_last_missing(&self) -> bool {
        let missing_players = self
            .room
            .players
            .iter()
            .filter(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing)
            .collect::<Vec<&Player>>();
        self.room.players.len() > 1
            && missing_players.len() == 1
            && missing_players[0].is_you
            && self.room.phase == GamePhase::Playing
    }

    pub fn new_phase(&mut self, _old: &Room) {
        if self.room.phase == GamePhase::Playing {
            self.vote = None;
            self.round_number += 1;
            self.is_notified = false;
            self.notify_vote_at = None;
            self.round_start = Instant::now();
        }
        self.has_updates = true;

        if self.room.phase == GamePhase::Revealed {
            let entry = HistoryEntry {
                round_number: self.round_number,
                average: self.average_votes(),
                length: Instant::now() - self.round_start,
                votes: self.room.players.clone(),
                deck: self.room.deck.clone(),
                own_vote: self.vote.clone(),
            };
            self.history.push(entry);
        }
    }

    pub fn merge_update(&mut self, update: Room) {
        debug!("room update: {:?}", update);

        let old = mem::replace(&mut self.room, update);
        if old.phase != self.room.phase {
            self.new_phase(&old);
        }

        if self.is_my_vote_last_missing() {
            if !self.is_notified && self.notify_vote_at == None {
                self.log_message(
                    LogLevel::Info,
                    "Your vote is the last one missing.".to_string(),
                );
                self.notify_vote_at = Some(Instant::now() + Duration::from_secs(8));
                self.has_updates = true;
            }
        } else {
            self.notify_vote_at = None;
        }

        self.check_auto_reveal_cancel();
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let data = data.trim();
        if data == "-" {
            self.vote = None;
            self.client.vote(None)?;
            return Ok(());
        }
        let was_last_missing = self.is_my_vote_last_missing();

        if self.deck_has_value(data) {
            let numeric = data.parse::<u8>();
            if numeric.is_ok() {
                let vote = VoteData::Number(numeric.unwrap());
                self.client.vote(Some(format!("{}", &vote).as_str()))?;
                self.vote = Some(vote);
            } else {
                let vote = VoteData::Special(data.to_string());
                self.client.vote(Some(data))?;
                self.vote = Some(vote);
            }
        } else {
            self.log_message(
                LogLevel::Error,
                format!("Card is not in the deck: {}", data),
            );
        }

        if !self.config.disable_auto_reveal && was_last_missing && self.vote.is_some() {
            debug!("Starting auto-reveal timer.");
            self.auto_reveal_at = Some(Instant::now() + Duration::from_secs(3));
        }
        Ok(())
    }

    pub fn rename(&mut self, data: String) -> AppResult<()> {
        self.name = data;
        self.client.change_name(self.name.as_str())?;

        Ok(())
    }

    pub fn reveal(&mut self) -> AppResult<()> {
        self.cancel_auto_reveal();
        if self.room.phase != GamePhase::Revealed {
            self.client.reveal()
        } else {
            Ok(())
        }
    }

    pub fn chat(&mut self, message: String) -> AppResult<()> {
        self.client.chat(message.as_str())
    }

    pub fn restart(&mut self) -> AppResult<()> {
        self.vote = None;
        if self.room.phase != GamePhase::Playing {
            self.client.reset()
        } else {
            Ok(())
        }
    }

    pub fn update(&mut self) -> AppResult<()> {
        let (room_updates, log_updates) = self.client.get_updates()?;
        // TODO: reconnect?

        for update in room_updates {
            self.merge_update(update);
        }

        self.update_server_log(log_updates);

        Ok(())
    }

    fn update_server_log(&mut self, log_updates: Vec<LogEntry>) {
        for log in log_updates {
            if self
                .log
                .iter()
                .find(|l| l.server_index == log.server_index)
                .is_none()
            {
                self.log.push(log);
            }
        }
    }

    pub fn log_message(&mut self, level: LogLevel, message: String) {
        self.log.push(LogEntry {
            timestamp: Instant::now(),
            level,
            message,
            source: LogSource::Client,
            server_index: None,
        })
    }

    pub fn average_votes(&self) -> f32 {
        let mut sum = 0f32;
        let mut count = 0f32;
        for player in &self.room.players {
            if let Vote::Revealed(VoteData::Number(n)) = player.vote {
                sum += n as f32;
                count += 1f32;
            }
        }
        sum / count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::predicate::*;
    use crate::web::client::MockPokerClient;

    fn create_test_room() -> Room {
        Room {
            name: "test-room".to_string(),
            deck: vec!["1".to_string(), "2".to_string(), "3".to_string(), "5".to_string(), "8".to_string(), "13".to_string()],
            phase: GamePhase::Playing,
            players: vec![Player {
                name: "Test User".to_string(),
                vote: Vote::Missing,
                is_you: true,
                user_type: UserType::Player,
            }],
        }
    }

    fn create_test_app(mock_client: MockPokerClient) -> App {
        App {
            running: true,
            vote: None,
            name: "Test User".to_string(),
            room: create_test_room(),
            client: Box::new(mock_client),
            log: vec![],
            round_number: 1,
            round_start: Instant::now(),
            config: Config::default(),
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
            has_updates: false,
            auto_reveal_at: None,
            history: vec![],
        }
    }

    #[test]
    fn test_vote_success() -> AppResult<()> {
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);

        app.vote("5")?;
        assert!(app.vote.is_some());
        if let Some(VoteData::Number(n)) = app.vote {
            assert_eq!(n, 5);
        } else {
            panic!("Expected numeric vote");
        }

        Ok(())
    }

    #[test]
    fn test_update_merges_room_data() -> AppResult<()> {
        let mut mock_client = MockPokerClient::new();

        // Set up the mock to return a room update
        let mut updated_room = create_test_room();
        updated_room.phase = GamePhase::Revealed;
        updated_room.players[0].vote = Vote::Revealed(VoteData::Number(5));

        mock_client
            .expect_get_updates()
            .times(1)
            .return_once(move || Ok((vec![updated_room], vec![])));

        let mut app = create_test_app(mock_client);

        // Initial state checks
        assert_eq!(app.room.phase, GamePhase::Playing);
        assert_eq!(app.room.players[0].vote, Vote::Missing);
        assert!(app.history.is_empty());

        // Perform update
        app.update()?;

        // Verify state changes
        assert_eq!(app.room.phase, GamePhase::Revealed);
        assert_eq!(app.room.players[0].vote, Vote::Revealed(VoteData::Number(5)));
        assert_eq!(app.history.len(), 1);
        assert_eq!(app.history[0].round_number, 1);
        assert_eq!(app.history[0].votes.len(), 1);
        assert_eq!(app.history[0].votes[0].vote, Vote::Revealed(VoteData::Number(5)));

        Ok(())
    }

    #[test]
    fn test_chat_message() -> AppResult<()> {
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_chat()
            .withf(|msg: &str| msg == "Hello!")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);
        app.chat("Hello!".to_string())?;

        Ok(())
    }

    #[test]
    fn test_autoreveal_triggers_when_last_to_vote() -> AppResult<()> {
        let mut mock_client = MockPokerClient::new();
        // Expect vote to be called first
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        // Expect reveal to be called after 3 seconds
        mock_client
            .expect_reveal()
            .times(1)
            .returning(|| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who has already voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Hidden,
            is_you: false,
            user_type: UserType::Player,
        });

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
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who hasn't voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Missing,
            is_you: false,
            user_type: UserType::Player,
        });

        // Cast our vote
        app.vote("5")?;

        // Verify auto-reveal timer is not set since we're not last
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }

    #[test]
    fn test_autoreveal_not_affected_by_spectators() -> AppResult<()> {
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        mock_client
            .expect_reveal()
            .times(1)
            .returning(|| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who has voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Hidden,
            is_you: false,
            user_type: UserType::Player,
        });

        // Add a spectator
        app.room.players.push(Player {
            name: "Spectator".to_string(),
            vote: Vote::Missing,
            is_you: false,
            user_type: UserType::Spectator,
        });

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
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who has voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Hidden,
            is_you: false,
            user_type: UserType::Player,
        });

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
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who has voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Hidden,
            is_you: false,
            user_type: UserType::Player,
        });

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Create updated room state with new player
        let mut updated_room = app.room.clone();
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
        let mut mock_client = MockPokerClient::new();
        mock_client
            .expect_vote()
            .withf(|x: &Option<&str>| x.unwrap() == "5")
            .times(1)
            .returning(|_| Ok(()));

        let mut app = create_test_app(mock_client);

        // Add another player who has voted
        app.room.players.push(Player {
            name: "Other Player".to_string(),
            vote: Vote::Hidden,
            is_you: false,
            user_type: UserType::Player,
        });

        // Cast our vote as the last person
        app.vote("5")?;

        // Verify auto-reveal timer is set
        assert!(app.auto_reveal_at.is_some());

        // Create updated room state with retracted vote
        let mut updated_room = app.room.clone();
        updated_room.players[1].vote = Vote::Missing;

        // Merge the room update
        app.merge_update(updated_room);

        // Verify auto-reveal was cancelled
        assert!(app.auto_reveal_at.is_none());

        Ok(())
    }
}
