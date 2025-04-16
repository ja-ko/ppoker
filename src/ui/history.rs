use crossterm::event::{KeyCode, KeyEvent};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::prelude::*;
use ratatui::widgets::{Cell, Row, Table, TableState};

use crate::app::{App, AppResult, HistoryEntry};
use crate::models::GamePhase;
use crate::ui::{colored_box_style, footer_entries, format_duration, Page, render_box, render_box_colored, UIAction, UiPage};
use crate::ui::voting::{format_vote, render_overview, render_own_vote};

pub struct HistoryPage {
    history_state: TableState,
}

impl HistoryPage {
    pub fn new() -> Self {
        Self {
            history_state: TableState::default(),
        }
    }
}

impl Page for HistoryPage {
    fn render(&mut self, app: &mut App, frame: &mut Frame) {
        if self.history_state.selected().is_none() && app.history.len() > 0 {
            self.history_state.select(Some(0));
        }

        let [header, body, footer] = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Fill(1),
                Constraint::Length(3)
            ])
            .areas(frame.area());

        render_overview(app, header, frame);
        self.render_main(app, body, frame);
        self.render_footer(app, footer, frame);
    }

    fn input(&mut self, _app: &mut App, event: KeyEvent) -> AppResult<UIAction> {
        return Ok(match event.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                UIAction::Quit
            }
            KeyCode::Char(c) if c == 'v' || c == '-' || c == 'h' || c.is_ascii_digit() => {
                UIAction::ChangeView(UiPage::Voting)
            }
            KeyCode::Down => {
                if let Some(s) = self.history_state.selected() {
                    let mut new_index = s.saturating_add(1);
                    if new_index >= _app.history.len() {
                        new_index = _app.history.len().saturating_sub(1);
                    }
                    self.history_state.select(Some(new_index));
                }
                UIAction::Continue
            }
            KeyCode::Up => {
                if let Some(s) = self.history_state.selected() {
                    self.history_state.select(Some(s.saturating_sub(1)));
                }
                UIAction::Continue
            }
            _ => { UIAction::Continue }
        });
    }
}

impl HistoryPage {
    fn render_main(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let [history, detail] = Layout::horizontal([
            Constraint::Percentage(40),
            Constraint::Percentage(60),
        ]).areas(rect);

        let [vote_summary, players] = Layout::vertical([
            Constraint::Length(9),
            Constraint::Fill(1),
        ]).areas(detail);

        let current_entry = self.history_state.selected().map(|idx| {
            &app.history[idx]
        });

        if let Some(current_entry) = current_entry {
            render_own_vote(
                &current_entry.votes,
                current_entry.average,
                GamePhase::Revealed,
                &current_entry.own_vote,
                &current_entry.deck,
                vote_summary,
                frame,
            );

            render_player_list(&current_entry, players, frame);
        }
        self.render_history(app, history, frame);
    }

    fn render_footer(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let entries = vec!["Vote", "↑", "↓", "Quit"];
        let mut footer = footer_entries(entries);
        if app.has_updates {
            footer = footer.style(Style::new().yellow());
        }
        frame.render_widget(footer, rect);
    }

    fn render_history(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let inner = render_box("History", rect, frame);

        let rows: Vec<Row> = app.history.iter().map(|entry| {
            Row::new(vec![
                Cell::from(Span::raw(entry.round_number.to_string())),
                Cell::from(Span::raw(format!("{:.1}", entry.average))),
                Cell::from(Span::raw(format_duration(&entry.length))),
            ])
        }).collect();

        let table = Table::new(rows, [Constraint::Length(5), Constraint::Length(8), Constraint::Fill(1)])
            .column_spacing(4)
            .header(Row::new(vec!["Round", "Average", "Duration"])
                .style(Style::new().bold())
                .bottom_margin(1))
            .highlight_symbol("> ")
            .row_highlight_style(Style::new().on_white().black());

        frame.render_stateful_widget(table, inner, &mut self.history_state);
    }
}

fn render_player_list(entry: &HistoryEntry, rect: Rect, frame: &mut Frame) {
    let inner = render_box_colored("Players", colored_box_style(GamePhase::Revealed), rect, frame);
    let mut longest_name = 0;
    let mut players = entry.votes.clone();
    players.sort();
    let rows: Vec<Row> = entry.votes.iter().map(|p| {
        if p.name.len() > longest_name {
            longest_name = p.name.len();
        }
        Row::new(vec![
            Cell::from(Span::raw(p.name.as_str())),
            Cell::from(format_vote(&p.vote, &entry.own_vote)),
        ])
    }).collect();

    let table = Table::new(rows, [Constraint::Length(longest_name as u16), Constraint::Fill(1)])
        .column_spacing(4)
        .header(Row::new(vec!["Name", "Vote"])
            .style(Style::new().bold())
            .bottom_margin(1));

    frame.render_widget(table, inner);
}
