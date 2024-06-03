use crossterm::event::{KeyCode, KeyEvent};
use log::LevelFilter;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::prelude::*;
use ratatui::style::Style;
use ratatui::widgets::{Block, BorderType, Paragraph, Wrap};
use tui_logger::{TuiLoggerLevelOutput, TuiLoggerSmartWidget, TuiWidgetEvent, TuiWidgetState};

use crate::app::{App, AppResult};
use crate::tui::UiPage;
use crate::ui::{Page, UIAction};

pub struct LogPage {
    state: TuiWidgetState,
}

impl LogPage {
    pub fn new() -> Self {
        Self {
            state: TuiWidgetState::default()
                .set_level_for_target("tungstenite::client", LevelFilter::Warn)
                .set_level_for_target("tungstenite::handshake::client", LevelFilter::Warn)
                .set_level_for_target("ppoker::web::ws", LevelFilter::Info)
        }
    }
}

impl Page for LogPage {
    fn render(&mut self, _app: &mut App, frame: &mut Frame) {
        let mut helptexts: Vec<Span> = vec![];
        helptexts.append(&mut help_spans("h", "Toggle target selector"));
        helptexts.append(&mut help_spans("f", "Toggle focus"));
        helptexts.append(&mut help_spans("UP/DOWN", "Navigate"));
        helptexts.append(&mut help_spans("LEFT/RIGHT", "Reduce/increase level"));
        helptexts.append(&mut help_spans("PAGEUP/PAGEDOWN", "Enter Page mode, scroll up/down"));
        helptexts.append(&mut help_spans("ESCAPE", "Exit page mode"));
        helptexts.append(&mut help_spans("SPACE", "Toggle hiding disabled targets"));
        helptexts.append(&mut help_spans("l", "Leave log view"));
        helptexts.append(&mut help_spans("q", "Quit application"));
        helptexts.pop();

        let help_paragraph = Paragraph::new(Line::from(helptexts))
            .wrap(Wrap { trim: true });

        let help_lines = help_paragraph.line_count(frame.size().width.saturating_sub(2)) as u16;

        let [log, help] = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Fill(1),
                Constraint::Length(help_lines + 2)
            ])
            .areas(frame.size());

        let widget = TuiLoggerSmartWidget::default()
            .style_error(Style::default().red())
            .style_debug(Style::default().cyan())
            .style_warn(Style::default().light_yellow())
            .style_info(Style::default().white())
            .output_separator('|')
            .output_timestamp(Some("%H:%M:%S".to_string()))
            .output_level(Some(TuiLoggerLevelOutput::Long))
            .output_target(true)
            .output_file(false)
            .output_line(false)
            .state(&self.state);

        frame.render_widget(widget, log);

        let block = Block::bordered()
            .title("Help")
            .title_alignment(Alignment::Left)
            .border_type(BorderType::Rounded);
        let help_inner = block.inner(help);

        frame.render_widget(block, help);

        frame.render_widget(help_paragraph, help_inner);
    }

    fn input(&mut self, _app: &mut App, event: KeyEvent) -> AppResult<UIAction> {
        match event.code.into() {
            KeyCode::Char('q') => return Ok(UIAction::Quit),
            KeyCode::Char(' ') => self.state.transition(TuiWidgetEvent::SpaceKey),
            KeyCode::Esc => self.state.transition(TuiWidgetEvent::EscapeKey),
            KeyCode::PageUp => self.state.transition(TuiWidgetEvent::PrevPageKey),
            KeyCode::PageDown => self.state.transition(TuiWidgetEvent::NextPageKey),
            KeyCode::Up => self.state.transition(TuiWidgetEvent::UpKey),
            KeyCode::Down => self.state.transition(TuiWidgetEvent::DownKey),
            KeyCode::Left => self.state.transition(TuiWidgetEvent::LeftKey),
            KeyCode::Right => self.state.transition(TuiWidgetEvent::RightKey),
            KeyCode::Char('h') => self.state.transition(TuiWidgetEvent::HideKey),
            KeyCode::Char('f') => self.state.transition(TuiWidgetEvent::FocusKey),
            KeyCode::Char('l') => return Ok(UIAction::ChangeView(UiPage::Voting)),
            _ => {}
        }
        return Ok(UIAction::Continue);
    }
}

fn help_spans<'a>(key: &'a str, description: &'a str) -> Vec<Span<'a>> {
    vec![
        Span::raw(key).style(Style::new().bold()),
        Span::raw(" - ").style(Style::new().gray()),
        Span::raw(description),
        Span::raw(" | ").style(Style::new().gray()),
    ]
}