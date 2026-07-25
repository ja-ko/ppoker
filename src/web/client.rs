use std::thread;
use std::time::{Duration, Instant};

use log::{error, info};
use ppoker_core::client::{Client, Clock, Transport};
use snafu::Snafu;

use crate::app::AppResult;
use crate::config::Config;
use crate::web::client::ClientError::ServerUpdateMissing;
use crate::web::ws::PokerSocket;

#[derive(Debug, Snafu)]
pub enum ClientError {
    #[snafu(display("Server did not send room update in time."))]
    ServerUpdateMissing,
}

pub struct NativeClock {
    baseline: Instant,
}

impl NativeClock {
    pub fn new() -> Self {
        Self {
            baseline: Instant::now(),
        }
    }
}

impl Clock for NativeClock {
    fn now(&self) -> Duration {
        self.baseline.elapsed()
    }
}

pub fn connect(config: &Config) -> AppResult<Client> {
    wait_for_initial_room(
        config.name.clone(),
        Box::new(PokerSocket::connect(config)?),
        thread::sleep,
    )
}

fn wait_for_initial_room(
    name: String,
    transport: Box<dyn Transport>,
    mut wait: impl FnMut(Duration),
) -> AppResult<Client> {
    let mut client = Client::new(name, std::rc::Rc::new(NativeClock::new()));
    client.connect(transport)?;
    for i in 0..20 {
        client.poll_next_room()?;
        if client.room().is_some() {
            info!("Got initial room state with delay {}ms.", i * 20);
            return Ok(client);
        } else {
            wait(Duration::from_millis(20));
        }
    }

    error!("Server did not send initial room update.");
    Err(Box::new(ServerUpdateMissing))
}

#[cfg(test)]
pub mod tests;
