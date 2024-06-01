use std::error;
use std::time::Instant;
use log::debug;
use crate::web::client::PokerClient;
use crate::config::Config;
use crate::models::{GamePhase, LogEntry, LogLevel, LogSource, Room, VoteData};

pub type AppResult<T> = std::result::Result<T, Box<dyn error::Error>>;

pub struct App {
    pub running: bool,
    pub vote: Option<VoteData>,
    pub name: String,

    pub room: Room,
    pub client: PokerClient,
    pub log: Vec<LogEntry>,

    pub config: Config,
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
            config,
        };
        result.update_server_log(log);

        Ok(result)
    }

    pub fn tick(&self) {}

    fn deck_has_value(&self, vote: u8) -> bool {
        self.room.deck.iter().find(|item| vote.to_string().eq_ignore_ascii_case(item)).is_some()
    }

    pub fn merge_update(&mut self, update: Room) {
        debug!("room update: {:?}", update);
        if update.phase == GamePhase::Playing && self.room.phase != GamePhase::Playing {
            self.vote = None;
        }
        self.room = update;
    }

    pub fn vote(&mut self, data: &str) -> AppResult<()> {
        let vote = data.parse::<u8>();
        if vote.is_ok() {
            let vote = vote.unwrap();
            if self.deck_has_value(vote) {
                let vote = VoteData::Number(vote);
                self.client.vote(Some(format!("{}", &vote).as_str()))?;
                self.vote = Some(vote);
            } else {
                self.log_message(LogLevel::Error, format!("Card is not in the deck: {}", data));
            }
        } else {
            self.vote = None;
            self.client.vote(None)?;
            if data != "-" {
                self.log_message(LogLevel::Error, format!("Unable to parse card: {}", data));
            }
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