use crossterm::event::KeyEvent;
use ratatui::Frame;
use crate::app::{App, AppResult};
use crate::tui::UiPage;

pub(crate) mod voting;
pub(crate) mod log;


pub enum UIAction{
    Continue,
    ChangeView(UiPage),
    Quit,
}
pub trait Page {
    fn render(&mut self, app: &mut App, frame: &mut Frame);
    fn input(&mut self, app: &mut App, event: KeyEvent) -> AppResult<UIAction>;
}