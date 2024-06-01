use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use crossterm::event;
use crossterm::event::{KeyEvent, KeyEventKind, MouseEvent, Event as CrosstermEvent};
use crate::app::AppResult;

#[derive(Clone, Copy, Debug)]
pub enum FocusChange {
    Gained,
    Lost
}

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Tick,
    Key(KeyEvent),
    Mouse(MouseEvent),
    Resize(u16, u16),
    Focus(FocusChange)
}

#[derive(Debug)]
pub struct EventHandler {
    receiver: mpsc::Receiver<Event>,
    shutdown: mpsc::Sender<()>,
    handler: thread::JoinHandle<()>,
}

impl EventHandler {
    pub fn new(tick_rate: u64) -> Self {
        let tick_rate = Duration::from_millis(tick_rate);
        let (sender, receiver) = mpsc::channel();
        let (shutdown, shutdown_recv) = mpsc::channel();
        let handler = {
            let sender = sender.clone();
            thread::spawn(move || {
                let mut last_tick = Instant::now();
                loop {
                    if shutdown_recv.try_recv().is_ok() {
                        break;
                    }
                    
                    let timeout = tick_rate
                        .checked_sub(last_tick.elapsed())
                        .unwrap_or(tick_rate);

                    if event::poll(timeout).expect("failed to poll new events") {
                        match event::read().expect("unable to read event") {
                            CrosstermEvent::Key(e) => {
                                if e.kind == KeyEventKind::Press {
                                    sender.send(Event::Key(e))
                                } else {
                                    Ok(())
                                }
                            }
                            CrosstermEvent::Mouse(e) => sender.send(Event::Mouse(e)),
                            CrosstermEvent::Resize(w, h) => sender.send(Event::Resize(w, h)),
                            CrosstermEvent::FocusGained => sender.send(Event::Focus(FocusChange::Gained)),
                            CrosstermEvent::FocusLost => sender.send(Event::Focus(FocusChange::Lost)),
                            CrosstermEvent::Paste(_) => unimplemented!(),
                        }
                            .expect("failed to send terminal event")
                    }

                    if last_tick.elapsed() >= tick_rate {
                        sender.send(Event::Tick).expect("failed to send tick event");
                        last_tick = Instant::now();
                    }
                    
                }
            })
        };
        Self {
            receiver,
            handler,
            shutdown,
        }
    }

    pub fn next(&self) -> AppResult<Event> {
        Ok(self.receiver.recv()?)
    }

    pub fn shutdown(self) {
        self.shutdown.send(()).expect("Unable to signal event thread to shutdown");
        self.handler.join().expect("Unable to join event thread.");
    }
}

