use crossterm::event::KeyEvent;
use enum_iterator::Sequence;
use ratatui::layout::{Alignment, Rect};
use ratatui::prelude::*;
use ratatui::widgets::{Block, BorderType, Paragraph};
use ratatui::Frame;
use std::time::Duration;

use crate::app::{App, AppResult};
use crate::models::GamePhase;

pub use history::HistoryPage;
pub use log::LogPage;
pub use voting::VotingPage;

mod history;
mod log;
mod voting;
mod text_input;
pub mod changelog;

#[derive(Debug, PartialEq, Clone, Copy, Hash, Ord, PartialOrd, Eq, Sequence)]
pub enum UiPage {
    Voting,
    Log,
    History,
    Changelog,
}

pub enum UIAction {
    Continue,
    ChangeView(UiPage),
    Quit,
}

pub trait Page {
    fn render(&mut self, app: &mut App, frame: &mut Frame);
    fn input(&mut self, app: &mut App, event: KeyEvent) -> AppResult<UIAction>;
    fn pasted(&mut self, _app: &mut App, _text: String) {}
}

fn render_box_colored(title: &str, color: Style, rect: Rect, frame: &mut Frame) -> Rect {
    let block = Block::bordered()
        .title(title)
        .title_alignment(Alignment::Left)
        .border_type(BorderType::Rounded)
        .border_style(color);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    inner
}

fn colored_box_style(game_phase: GamePhase) -> Style {
    match game_phase {
        GamePhase::Revealed => Style::new().light_blue(),
        _ => Style::new().white(),
    }
}

fn render_box(title: &str, rect: Rect, frame: &mut Frame) -> Rect {
    render_box_colored(title, Style::new().white(), rect, frame)
}

fn trim_name(name: &str) -> &str {
    let name = name.trim();
    let mut chars = name.char_indices();
    let end = chars.nth(25);
    if let Some((idx, _char)) = end {
        &name[..idx]
    } else {
        name
    }
    // todo: escape the name for control chars
}

fn render_confirmation_box(prompt: &str, rect: Rect, frame: &mut Frame) {
    let block = Block::bordered()
        .title("Confirmation")
        .title_alignment(Alignment::Center)
        .border_type(BorderType::Rounded);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let paragraph = Paragraph::new(Line::from(vec![
        Span::raw(prompt),
        Span::raw(" Y").bold(),
        Span::raw("es/"),
        Span::raw("N").bold(),
        Span::raw("o"),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(paragraph, inner);
}

pub struct FooterEntry {
    pub name: String,
    pub shortcut: char,
    pub highlight: bool,
}

fn footer_entries(entries: Vec<FooterEntry>) -> Paragraph<'static> {
    let mut spans: Vec<Span<'static>> = entries
        .iter()
        .flat_map(|entry| {
            let name = &entry.name;
            let shortcut = entry.shortcut;
            let shortcut_style = Style::default()
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::UNDERLINED);

            let mut result = vec![Span::raw(" ")];

            // Check if the name contains the shortcut letter
            if let Some(pos) = name.to_lowercase().find(shortcut.to_lowercase().next().unwrap_or(shortcut)) {
                let mut char_indices = name.char_indices();
                let shortcut_char_start = pos;
                let shortcut_char_end = char_indices
                    .find(|(idx, _)| *idx == pos)
                    .and_then(|(_, c)| Some(pos + c.len_utf8()))
                    .unwrap_or(pos + 1);

                if shortcut_char_start > 0 {
                    result.push(Span::raw(name[..shortcut_char_start].to_string()));
                }

                result.push(Span::styled(
                    name[shortcut_char_start..shortcut_char_end].to_string(),
                    shortcut_style
                ));

                // Add the rest of the name
                if shortcut_char_end < name.len() {
                    result.push(Span::raw(name[shortcut_char_end..].to_string()));
                }
            } else {
                // The shortcut isn't in the string, so we add (shortcut) at the end
                result.push(Span::raw(name.to_string()));
                result.push(Span::raw(" ("));
                result.push(Span::styled(
                    shortcut.to_string(),
                    shortcut_style
                ));
                result.push(Span::raw(")"));
            }

            if entry.highlight {
                result = result.into_iter().map(|span| {
                    let content = span.content.to_string();
                    let new_style = span.style.fg(Color::Yellow);
                    Span::styled(content, new_style)
                }).collect();
            }
            result.push(Span::raw(" |"));

            result
        })
        .collect();

    if !spans.is_empty() {
        spans.remove(spans.len() - 1);
    }

    Paragraph::new(vec![Line::from(""), Line::from(spans)])
}

fn format_duration(duration: &Duration) -> String {
    let secs = duration.as_secs();
    let minutes = secs / 60;
    let hours = minutes / 60;
    if hours > 1 {
        format!("{} hours {} minutes", hours, minutes % 60)
    } else if minutes > 1 {
        format!("{} minutes {} seconds", minutes, secs % 60)
    } else if secs >= 100 {
        format!("{} minute {} seconds", minutes, secs % 60)
    } else {
        format!("{} seconds", secs)
    }
}


#[cfg(test)]
pub mod tests {
    use crossterm::event::{KeyCode, KeyModifiers};
    use ratatui::backend::TestBackend;
    use super::*;
    pub fn send_input<P: Page>(key: KeyCode, terminal: &mut Terminal<TestBackend>, page: &mut P, app: &mut App) {
        page.input(app, KeyEvent::new(key, KeyModifiers::empty())).unwrap();
        tick(terminal, page, app);
    }

    pub fn send_input_with_modifiers<P: Page>(key: KeyCode, modifier: KeyModifiers, terminal: &mut Terminal<TestBackend>, page: &mut P, app: &mut App) {
        page.input(app, KeyEvent::new(key, modifier)).unwrap();
        tick(terminal, page, app);
    }

    pub fn tick<P: Page>(terminal: &mut Terminal<TestBackend>, page: &mut P, app: &mut App) {
        app.update().unwrap();
        terminal.draw(|frame| page.render(app, frame)).unwrap();
    }
}
