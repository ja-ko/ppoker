use std::{io, panic};
use std::collections::HashMap;
use crossterm::event::KeyEvent;
use crossterm::terminal;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use log::{debug};
use ratatui::prelude::*;
use crate::app::{App, AppResult};
use crate::events::{Event, EventHandler, FocusChange};
use crate::ui::log::LogPage;
use crate::ui::{Page, UIAction};
use crate::ui::voting::VotingPage;

#[derive(Debug, PartialEq, Clone, Copy, Hash, Ord, PartialOrd, Eq)]
pub enum UiPage {
    Voting,
    Log,
}

pub struct Tui<B: Backend> {
    terminal: Terminal<B>,
    pub events: EventHandler,
    pub current_page: UiPage,
    pages: HashMap<UiPage, Box<dyn Page>>,
}

impl<B: Backend> Tui<B> {
    pub fn new(terminal: Terminal<B>, events: EventHandler) -> Self {
        let pages: HashMap<UiPage, Box<dyn Page>> = HashMap::new();
        Self { terminal, events, current_page: UiPage::Voting, pages }
    }
    pub fn init(&mut self) -> AppResult<()> {
        terminal::enable_raw_mode()?;
        crossterm::execute!(io::stderr(), EnterAlternateScreen)?;

        let panic_hook = panic::take_hook();
        panic::set_hook(Box::new(move |panic| {
            Self::reset().expect("failed to reset the terminal");
            panic_hook(panic);
        }));

        self.terminal.hide_cursor()?;
        self.terminal.clear()?;
        Ok(())
    }

    //noinspection Duplicates
    pub fn draw(&mut self, app: &mut App) -> AppResult<()> {
        let page = match self.current_page {
            UiPage::Voting => {
                self.pages.entry(UiPage::Voting).or_insert(Box::new(VotingPage::new()))
            }
            UiPage::Log => {
                self.pages.entry(UiPage::Log).or_insert(Box::new(LogPage::new()))
            }
        };
        self.terminal.draw(|frame| page.render(app, frame))?;
        Ok(())
    }

    fn reset() -> AppResult<()> {
        terminal::disable_raw_mode()?;
        crossterm::execute!(io::stderr(), LeaveAlternateScreen)?;
        Ok(())
    }

    pub fn exit(mut self) -> AppResult<()> {
        self.events.shutdown();
        Self::reset()?;
        self.terminal.show_cursor()?;
        Ok(())
    }

    pub fn handle_events(&mut self, app: &mut App) -> AppResult<()> {
        match self.events.next()? {
            Event::Tick => app.tick(),
            Event::Key(event) => self.handle_key(event, app)?,
            Event::Mouse(_) => {}
            Event::Resize(_, _) => {}
            Event::Focus(change) => {
                debug!("Focus change: {:?}", change);
                match change {
                    FocusChange::Gained => {
                        app.has_focus = true;
                    }
                    FocusChange::Lost => {
                        app.has_focus = false;
                    }
                }
            }
        }
        Ok(())
    }

    fn handle_key(&mut self, key_event: KeyEvent, app: &mut App) -> AppResult<()> {
        let page = self.get_current_page_impl();
        let action = page.input(app, key_event)?;
        match action {
            UIAction::Continue => {}
            UIAction::ChangeView(page) => { self.current_page = page }
            UIAction::Quit => { app.running = false; }
        }
        Ok(())
    }

    #[inline]
    //noinspection Duplicates
    fn get_current_page_impl(&mut self) -> &mut Box<dyn Page> {
        match self.current_page {
            UiPage::Voting => {
                self.pages.entry(UiPage::Voting).or_insert(Box::new(VotingPage::new()))
            }
            UiPage::Log => {
                self.pages.entry(UiPage::Log).or_insert(Box::new(LogPage::new()))
            }
        }
    }
}