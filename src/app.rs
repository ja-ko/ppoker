use std::error;
use std::time::{Duration, Instant};

use log::{debug, error, info};
use notify_rust::{Notification, Timeout};

use crate::config::Config;
use crate::models::{GamePhase, LogEntry, LogLevel, LogSource, Room, Vote, VoteData};
use crate::web::client::PokerClient;

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

pub struct App {
    pub running: bool,
    pub vote: Option<VoteData>,
    pub name: String,

    pub room: Room,
    pub client: PokerClient,
    pub log: Vec<LogEntry>,

    pub round_number: u32,

    pub config: Config,

    pub has_focus: bool,
    notify_vote_at: Option<Instant>,
    is_notified: bool,
}

impl App {
    pub fn new(config: Config) -> AppResult<Self> {
        let (client, room, log) = PokerClient::new(&config)?;

        let mut result = Self {
            running: true,
            vote: None,
            name: config.name.clone(),
            room,
            client,
            log: vec![],
            round_number: 1,
            config,
            has_focus: true,
            notify_vote_at: None,
            is_notified: false,
        };
        result.update_server_log(log);

        Ok(result)
    }

    pub fn tick(&mut self) {
        if let Some(notify_at) = &self.notify_vote_at {
            if *notify_at < Instant::now() && !self.is_notified {
                if self.has_focus {
                    info!("Skipping notification because user has application focused.")
                } else {
                    if self.config.disable_notifications {
                        info!("Skipping notification because user has them disabled.");
                    } else {
                        info!("Notifying user of missing vote.");
                        if let Err(e) = Notification::new()
                            .summary("Planning Poker")
                            .body("Your vote is the last one missing.")
                            .timeout(Timeout::Milliseconds(10000))
                            .show() {
                            error!("Failed to send notification: {}", e);
                        }
                    }
                }
                self.is_notified = true;
                self.notify_vote_at = None;
            }
        }
    }

    #[inline]
    fn deck_has_value(&self, vote: &str) -> bool {
        self.room.deck.iter().find(|item| item.eq_ignore_ascii_case(vote)).is_some()
    }

    #[inline]
    fn is_my_vote_last_missing(&self) -> bool {
        self.room.players.len() > 1
            && self.room.players.iter().filter(|p| p.vote == Vote::Missing).count() == 1
            && self.vote.is_none()
            && self.room.phase == GamePhase::Playing
    }

    pub fn merge_update(&mut self, update: Room) {
        debug!("room update: {:?}", update);
        if update.phase == GamePhase::Playing && self.room.phase != GamePhase::Playing {
            self.vote = None;
            self.round_number += 1;
            self.is_notified = false;
            self.notify_vote_at = None;
        }
        self.room = update;
        if self.is_my_vote_last_missing() {
            if !self.is_notified && self.notify_vote_at == None {
                self.log_message(LogLevel::Info, "Your vote is the last one missing.".to_string());
                self.notify_vote_at = Some(Instant::now() + Duration::from_secs(15));
            }
        } else {
            self.notify_vote_at = None;
        }
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let data = data.trim();
        if data == "-" {
            self.vote = None;
            return Ok(());
        }

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
            self.log_message(LogLevel::Error, format!("Card is not in the deck: {}", data));
        }
        Ok(())
    }

    pub fn rename(&mut self, data: String) -> AppResult<()> {
        self.name = data;
        self.client.change_name(self.name.as_str())?;

        Ok(())
    }

    pub fn reveal(&mut self) -> AppResult<()> {
        self.client.reveal()
    }

    pub fn chat(&mut self, message: String) -> AppResult<()> {
        self.client.chat(message.as_str())
    }

    pub fn restart(&mut self) -> AppResult<()> {
        self.vote = None;
        self.client.reset()
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
            if self.log.iter().find(|l| l.server_index == log.server_index).is_none() {
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
}