use std::collections::HashMap;
use std::{io, panic};

use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange, KeyEvent,
};
use crossterm::terminal;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use log::debug;
use ratatui::prelude::*;

use crate::app::{App, AppResult};
use crate::events::{Event, EventHandler, FocusChange};
use crate::ui::HistoryPage;
use crate::ui::LogPage;
use crate::ui::VotingPage;
use crate::ui::{Page, UIAction, UiPage};

pub struct Tui<B: Backend> {
    terminal: Terminal<B>,
    pub events: EventHandler,
    pub current_page: UiPage,
    pages: HashMap<UiPage, Box<dyn Page>>,
}

impl<B: Backend> Tui<B> {
    pub fn new(terminal: Terminal<B>, events: EventHandler) -> Self {
        let mut pages: HashMap<UiPage, Box<dyn Page>> = HashMap::new();
        enum_iterator::all::<UiPage>().for_each(|page| match page {
            UiPage::Voting => {
                pages.insert(page, Box::new(VotingPage::new()));
            }
            UiPage::Log => {
                pages.insert(page, Box::new(LogPage::new()));
            }
            UiPage::History => {
                pages.insert(page, Box::new(HistoryPage::new()));
            }
        });
        Self {
            terminal,
            events,
            current_page: UiPage::Voting,
            pages,
        }
    }
    pub fn init(&mut self) -> AppResult<()> {
        terminal::enable_raw_mode()?;
        crossterm::execute!(
            io::stderr(),
            EnterAlternateScreen,
            EnableFocusChange,
            EnableBracketedPaste
        )?;

        let panic_hook = panic::take_hook();
        panic::set_hook(Box::new(move |panic| {
            tui_logger::move_events();
            Self::reset().expect("failed to reset the terminal");
            panic_hook(panic);
        }));

        self.terminal.hide_cursor()?;
        self.terminal.clear()?;
        Ok(())
    }

    pub fn draw(&mut self, app: &mut App) -> AppResult<()> {
        let page = self.pages.get_mut(&self.current_page).unwrap();
        self.terminal.draw(|frame| page.render(app, frame))?;
        Ok(())
    }

    fn reset() -> AppResult<()> {
        terminal::disable_raw_mode()?;
        crossterm::execute!(
            io::stderr(),
            LeaveAlternateScreen,
            DisableFocusChange,
            DisableBracketedPaste
        )?;
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
            Event::Tick => app.tick()?,
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
            Event::Paste(text) => self
                .pages
                .get_mut(&self.current_page)
                .unwrap()
                .pasted(app, text),
        }
        Ok(())
    }

    fn handle_key(&mut self, key_event: KeyEvent, app: &mut App) -> AppResult<()> {
        let page = self.pages.get_mut(&self.current_page).unwrap();
        let action = page.input(app, key_event)?;
        match action {
            UIAction::Continue => {}
            UIAction::ChangeView(page) => self.current_page = page,
            UIAction::Quit => {
                app.running = false;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::create_test_app;
    use crate::web::client::tests::LocalMockPokerClient;
    use crossterm::event::{KeyCode, KeyModifiers};
    #[cfg(test)]
    use insta::assert_snapshot;
    use ratatui::backend::TestBackend;

    fn create_test_terminal() -> Terminal<TestBackend> {
        Terminal::new(TestBackend::new(80, 24)).unwrap()
    }

    fn create_test_tui() -> (Tui<TestBackend>, App) {
        let terminal = create_test_terminal();
        let events = EventHandler::new(100);
        let tui = Tui::new(terminal, events);
        let app = create_test_app(Box::new(LocalMockPokerClient::new("test")));
        (tui, app)
    }

    #[test]
    fn test_page_switching() {
        let (mut tui, mut app) = create_test_tui();

        // Initially should be on voting page
        assert_eq!(tui.current_page, UiPage::Voting);
        tui.draw(&mut app).unwrap();
        assert_snapshot!("initial_voting_page", tui.terminal.backend());

        // Switch to history page with 'h'
        tui.handle_key(
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::empty()),
            &mut app,
        )
        .unwrap();
        assert_eq!(tui.current_page, UiPage::History);
        tui.draw(&mut app).unwrap();
        assert_snapshot!("switched_to_history", tui.terminal.backend());

        // Switch back to voting page with 'v'
        // This is done because you can only switch to the log page from the voting page
        tui.handle_key(
            KeyEvent::new(KeyCode::Char('v'), KeyModifiers::empty()),
            &mut app,
        )
        .unwrap();
        assert_eq!(tui.current_page, UiPage::Voting);
        tui.draw(&mut app).unwrap();

        // Switch to log page with 'l'
        tui.handle_key(
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::empty()),
            &mut app,
        )
        .unwrap();
        assert_eq!(tui.current_page, UiPage::Log);
        tui.draw(&mut app).unwrap();
        assert_snapshot!("switched_to_log", tui.terminal.backend());

        // Switch back to voting page with 'l'
        tui.handle_key(
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::empty()),
            &mut app,
        )
        .unwrap();
        assert_eq!(tui.current_page, UiPage::Voting);
        tui.draw(&mut app).unwrap();
        assert_snapshot!("back_to_voting", tui.terminal.backend());
    }
}
