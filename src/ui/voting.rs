use std::collections::HashMap;
use std::ops::{AddAssign, DerefMut};
use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use log::debug;
use ratatui::prelude::*;
use ratatui::widgets::{
    Bar, BarChart, BarGroup, Cell, List, ListDirection, ListItem, ListState, Paragraph, Row, Table,
    Wrap,
};
use ratatui::Frame;
use tui_big_text::{BigText, PixelSize};

use crate::app::{App, AppResult};
use crate::models::{GamePhase, LogLevel, LogSource, Player, UserType, Vote, VoteData};
use crate::ui::text_input::TextInput;
use crate::ui::{
    colored_box_style, footer_entries, format_duration, render_box, render_box_colored,
    render_confirmation_box, trim_name, Page, UIAction, UiPage,
};

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum InputMode {
    Menu,
    Vote,
    Name,
    Chat,
    RevealConfirm,
    ResetConfirm,
    AutoReveal,
}

pub struct VotingPage {
    pub input_mode: InputMode,
    pub text_input: TextInput,
    last_phase: GamePhase,
}

impl Page for VotingPage {
    fn render(&mut self, app: &mut App, frame: &mut Frame) {
        app.has_updates = false;

        if app.auto_reveal_at.is_some() && self.input_mode != InputMode::AutoReveal {
            self.input_mode = InputMode::AutoReveal;
        } else if app.auto_reveal_at.is_none() && self.input_mode == InputMode::AutoReveal {
            self.input_mode = InputMode::Menu;
        }

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Fill(1),
                Constraint::Length(3),
            ])
            .split(frame.area());

        let header = chunks[0];
        let primary = chunks[1];
        let footer = chunks[2];

        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(20), Constraint::Min(26)])
            .split(primary);

        let left_side = chunks[0];
        let right_side = chunks[1];

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(9), Constraint::Fill(1)])
            .split(right_side);

        let vote_view = chunks[0];
        let log = chunks[1];

        let (votes, spectators) = if app
            .room
            .players
            .iter()
            .any(|p| p.user_type == UserType::Spectator)
        {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
                .split(left_side);
            (chunks[0], Some(chunks[1]))
        } else {
            (left_side, None)
        };

        if app.room.phase != self.last_phase {
            if self.input_mode != InputMode::Name {
                self.input_mode = InputMode::Menu;
            }
            self.last_phase = app.room.phase;
        }

        match app.room.phase {
            GamePhase::Revealed if app.history.len() > 0 => {
                let entry = app
                    .history
                    .as_slice()
                    .last()
                    .expect("Can't get last item of history.");
                render_own_vote(
                    &entry.votes,
                    entry.average,
                    GamePhase::Revealed,
                    &entry.own_vote,
                    &entry.deck,
                    vote_view,
                    frame,
                );
            }
            _ => {
                render_own_vote(
                    &app.room.players,
                    app.average_votes(),
                    app.room.phase,
                    &app.vote,
                    &app.room.deck,
                    vote_view,
                    frame,
                );
            }
        }
        self.render_log(app, log, frame);
        self.render_votes(app, votes, frame);
        if let Some(spectators) = spectators {
            self.render_spectators(app, spectators, frame);
        }
        render_overview(app, header, frame);
        self.render_footer(app, footer, frame);
    }

    fn input(&mut self, app: &mut App, event: KeyEvent) -> AppResult<UIAction> {
        match &self.input_mode {
            InputMode::Menu => {
                match event.code {
                    KeyCode::Esc | KeyCode::Char('q') => {
                        return Ok(UIAction::Quit);
                    }
                    KeyCode::Char(c) if c.is_ascii_digit() => {
                        self.change_mode(InputMode::Vote, c.to_string(), app);
                    }
                    KeyCode::Char('-') => self.change_mode(InputMode::Vote, String::from("-"), app),
                    KeyCode::Char('v') => self.change_mode(InputMode::Vote, String::new(), app),
                    KeyCode::Char('c') if !event.modifiers.contains(KeyModifiers::CONTROL) => {
                        self.change_mode(InputMode::Chat, String::new(), app)
                    }
                    KeyCode::Char('n') => self.change_mode(InputMode::Name, app.name.clone(), app),
                    KeyCode::Char('l') => {
                        return Ok(UIAction::ChangeView(UiPage::Log));
                    }
                    KeyCode::Char('r') => {
                        if app.room.phase == GamePhase::Playing {
                            if app.room.players.iter().any(|p| {
                                p.user_type != UserType::Spectator && p.vote == Vote::Missing
                            }) {
                                self.input_mode = InputMode::RevealConfirm;
                            } else {
                                app.reveal()?;
                            }
                        } else {
                            self.input_mode = InputMode::ResetConfirm;
                        }
                    }
                    KeyCode::Char('h') => {
                        return Ok(UIAction::ChangeView(UiPage::History));
                    }
                    _ => {}
                }
            }
            InputMode::Vote | InputMode::Name | InputMode::Chat => match event.code {
                KeyCode::Esc => {
                    self.cancel_input();
                }
                KeyCode::Enter => {
                    self.confirm_input(app)?;
                }
                _ => {
                    self.text_input.handle_input(&event);
                }
            },
            InputMode::ResetConfirm => match event.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    app.restart()?;
                    self.input_mode = InputMode::Menu;
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.input_mode = InputMode::Menu;
                }
                KeyCode::Char('q') => {
                    return Ok(UIAction::Quit);
                }
                _ => {}
            },
            InputMode::RevealConfirm => match event.code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    app.reveal()?;
                    self.input_mode = InputMode::Menu;
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.input_mode = InputMode::Menu;
                }
                KeyCode::Char('q') => {
                    return Ok(UIAction::Quit);
                }
                _ => {}
            },
            InputMode::AutoReveal => match event.code {
                KeyCode::Char('y') | KeyCode::Enter | KeyCode::Char('r') | KeyCode::Char(' ') => {
                    app.reveal()?;
                    self.input_mode = InputMode::Menu;
                    debug!("Auto reveal preempted - revealing");
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.input_mode = InputMode::Menu;
                    app.cancel_auto_reveal();
                    debug!("Auto reveal preempted - canceled");
                }
                KeyCode::Char('q') => {
                    return Ok(UIAction::Quit);
                }
                _ => {}
            },
        }
        Ok(UIAction::Continue)
    }

    fn pasted(&mut self, _app: &mut App, text: String) {
        let text = VotingPage::sanitize_string(text.as_str());
        match self.input_mode {
            InputMode::Chat | InputMode::Vote | InputMode::Name => {
                self.text_input.paste(text.as_str());
            }
            _ => {}
        }
    }
}

impl VotingPage {
    pub fn new() -> Self {
        Self {
            input_mode: InputMode::Menu,
            text_input: TextInput::new(),
            last_phase: GamePhase::Playing,
        }
    }

    fn sanitize_string(s: &str) -> String {
        s.chars()
            .filter(|&c| !c.is_control())
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    pub fn change_mode(&mut self, mode: InputMode, default_text: String, app: &App) {
        if mode == InputMode::Vote && app.room.phase == GamePhase::Playing {
            self.start_input(mode, default_text)
        } else if mode == InputMode::Name || mode == InputMode::Chat {
            self.start_input(mode, default_text)
        }
    }

    fn start_input(&mut self, mode: InputMode, default: String) {
        self.input_mode = mode;
        self.text_input.set_text(default);
    }

    pub fn confirm_input(&mut self, app: &mut App) -> AppResult<()> {
        let buffer = VotingPage::sanitize_string(self.text_input.text());

        match self.input_mode {
            InputMode::Vote if app.room.phase == GamePhase::Playing => {
                app.vote(buffer.as_str())?;
                self.cancel_input();
            }
            InputMode::Name => {
                app.rename(buffer)?;
                self.cancel_input();
            }
            InputMode::Chat => {
                app.chat(buffer)?;
                self.cancel_input();
            }
            _ => {}
        }

        Ok(())
    }

    pub fn cancel_input(&mut self) {
        self.text_input.clear();
        self.input_mode = InputMode::Menu;
    }

    fn render_votes(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box_colored("Players", colored_box_style(app.room.phase), rect, frame);

        let mut longest_name: usize = 0;

        let mut players = app.room.players.clone();
        players.retain(|p| p.user_type == UserType::Player);
        if app.room.phase == GamePhase::Revealed {
            players.sort();
        } else {
            players.sort_by(|p, p2| p.name.cmp(&p2.name))
        }

        let rows: Vec<Row> = players
            .iter()
            .map(|player| {
                let player_color = if player.is_you {
                    Style::new().green()
                } else {
                    Style::new()
                };
                let name = crate::ui::voting::trim_name(&player.name);
                if name.len() > longest_name {
                    longest_name = name.len()
                }

                Row::new(vec![
                    Cell::from(Span::styled(name, player_color)),
                    Cell::from(format_vote(&player.vote, &app.vote)),
                ])
            })
            .collect();

        let table = Table::new(
            rows,
            [
                Constraint::Length(longest_name as u16),
                Constraint::Length(7),
            ],
        )
        .column_spacing(3)
        .header(
            Row::new(vec!["Name", "Vote"])
                .style(Style::new().bold())
                .bottom_margin(1),
        );

        frame.render_widget(table, rect);
    }

    fn render_spectators(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box_colored("Spectators", colored_box_style(app.room.phase), rect, frame);

        let mut longest_name: usize = 0;

        let mut spectators = app.room.players.clone();
        spectators.retain(|p| p.user_type == UserType::Spectator);
        spectators.sort();

        let rows: Vec<Row> = spectators
            .iter()
            .map(|spectator| {
                let name = trim_name(&spectator.name);
                if name.len() > longest_name {
                    longest_name = name.len()
                }

                Row::new(vec![
                    Cell::from(Span::styled(name, Style::new())),
                    Cell::from(format_vote(&spectator.vote, &app.vote)),
                ])
            })
            .collect();

        let table = Table::new(rows, [Constraint::Fill(1)])
            .column_spacing(3)
            .header(
                Row::new(vec!["Name"])
                    .style(Style::new().bold())
                    .bottom_margin(1),
            );

        frame.render_widget(table, rect);
    }

    fn render_log(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box_colored("Log", colored_box_style(app.room.phase), rect, frame);

        let entries: Vec<ListItem> = app
            .log
            .iter()
            .map(|logentry| {
                let color = match logentry.level {
                    LogLevel::Chat => Style::new().light_blue(),
                    LogLevel::Info => {
                        if logentry.source == LogSource::Server {
                            Style::new()
                        } else {
                            Style::new().yellow()
                        }
                    }
                    LogLevel::Error => Style::new().red(),
                };
                let prefix = match logentry.level {
                    LogLevel::Chat => String::from(""),
                    _ => {
                        format!("[{:?}]: ", logentry.source)
                    }
                };
                let message = VotingPage::sanitize_string(logentry.message.as_str());
                ListItem::new(format!("{}{}", prefix, message)).style(color)
            })
            .collect();

        let mut state =
            ListState::default().with_offset(entries.len().saturating_sub(rect.height as usize));
        let list = List::new(entries).direction(ListDirection::TopToBottom);

        frame.render_stateful_widget(list, rect, &mut state);
    }

    fn render_footer(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        match &self.input_mode {
            InputMode::Vote => {
                let layout = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Length(20), Constraint::Fill(1)])
                    .split(rect);

                self.render_text_input("Vote", layout[0], frame);
                let mut spans: Vec<Span> = app
                    .room
                    .deck
                    .iter()
                    .flat_map(|item| vec![Span::raw(" "), Span::raw(item.clone()), Span::raw(" |")])
                    .collect();

                spans.insert(0, Span::raw("   Possible values:"));
                spans.remove(spans.len() - 1);

                let possible_values = Paragraph::new(vec![Line::from(""), Line::from(spans)])
                    .style(Style::new().gray());
                frame.render_widget(possible_values, layout[1]);
            }
            InputMode::Name => {
                self.render_text_input("Rename", rect, frame);
            }
            InputMode::Chat => {
                self.render_text_input("Chat", rect, frame);
            }
            InputMode::RevealConfirm => {
                render_confirmation_box(
                    "Not everyone has voted yet. Confirm you want to reveal the cards?",
                    rect,
                    frame,
                );
            }
            InputMode::ResetConfirm => {
                render_confirmation_box("Confirm you want to start a new round?", rect, frame);
            }
            InputMode::AutoReveal => {
                render_confirmation_box(
                    &format!(
                        "Automatically revealing cards in {} seconds.",
                        app.auto_reveal_at
                            .map(|when| ((when - Instant::now()).as_secs() + 1).to_string())
                            .unwrap_or("<probably not gonna happen>".to_string())
                    ),
                    rect,
                    frame,
                );
            }
            InputMode::Menu => {
                let entries = if app.room.phase == GamePhase::Playing {
                    vec!["Vote", "Reveal", "History", "Name change", "Chat", "Quit"]
                } else {
                    vec!["Restart", "History", "Name change", "Chat", "Quit"]
                };

                frame.render_widget(footer_entries(entries), rect);
            }
        }
    }

    fn render_text_input(&mut self, title: &str, rect: Rect, frame: &mut Frame) {
        let rect = render_box(title, rect, frame);
        let cursor_x = rect.x + self.text_input.cursor_offset();

        self.text_input.render(rect, frame.buffer_mut());
        frame.set_cursor_position((cursor_x, rect.y));
    }
}

pub(super) fn render_own_vote(
    players: &Vec<Player>,
    average_vote: f32,
    phase: GamePhase,
    own_vote: &Option<VoteData>,
    deck: &Vec<String>,
    rect: Rect,
    frame: &mut Frame,
) {
    let constraints = if phase == GamePhase::Revealed {
        [
            Constraint::Length(26),
            Constraint::Length((deck.len() * 3) as u16),
            Constraint::Length(34),
        ]
    } else {
        [
            Constraint::Length(26),
            Constraint::Fill(1),
            Constraint::Fill(1),
        ]
    };
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(constraints)
        .split(rect);
    let small_box = chunks[0];
    let bar_chart = chunks[1];
    let average = chunks[2];

    if phase == GamePhase::Revealed {
        let inner = render_box_colored(
            "Vote distribution",
            colored_box_style(phase),
            bar_chart,
            frame,
        );

        let mut cards = HashMap::new();
        for player in players {
            let card = format!("{}", player.vote);
            cards.entry(card).or_insert(0).deref_mut().add_assign(1);
        }

        let cards: Vec<_> = deck
            .iter()
            .map(|card| {
                Bar::default()
                    .text_value(card.clone())
                    .value(*cards.get(card).unwrap_or(&0))
            })
            .collect();

        let chart = BarChart::default()
            .bar_width(2)
            .bar_gap(1)
            .data(BarGroup::default().bars(cards.as_slice()));

        frame.render_widget(chart, inner);

        let inner = render_box_colored("Average vote", colored_box_style(phase), average, frame);
        let text = BigText::builder()
            .pixel_size(PixelSize::Full)
            .style(Style::new().light_blue())
            .alignment(Alignment::Center)
            .lines(vec![format!("{:.1}", average_vote).into()])
            .build();
        frame.render_widget(text, inner);
    }

    let inner = render_box_colored("Your vote", colored_box_style(phase), small_box, frame);

    let (color, text) = if let Some(vote) = &own_vote {
        (Style::new().green(), vote.to_string())
    } else {
        (Style::new().red(), "-".to_owned())
    };

    let text = BigText::builder()
        .pixel_size(PixelSize::Full)
        .style(color)
        .alignment(Alignment::Center)
        .lines(vec![text.into()])
        .build();
    frame.render_widget(text, inner);
}

pub(super) fn render_overview(app: &mut App, rect: Rect, frame: &mut Frame) {
    let rect = render_box("Overview", rect, frame);

    let name = trim_name(app.name.as_str());
    let state_color = if app.room.phase == GamePhase::Playing {
        Style::new().yellow()
    } else {
        Style::new().light_blue()
    };

    let duration = if app.room.phase == GamePhase::Revealed && app.history.len() > 0 {
        format_duration(&app.history[app.history.len() - 1].length)
    } else {
        format_duration(&(Instant::now() - app.round_start))
    };

    let mut text = Line::from(vec![
        Span::raw("Name: "),
        Span::raw(name).bold(),
        Span::raw(" | Room: "),
        Span::raw(app.room.name.as_str()).bold(),
        Span::raw(" | Server: "),
        Span::raw(app.config.server.as_str()).bold(),
        Span::raw(" | State: "),
        Span::raw(format!("{}", app.room.phase)).style(state_color.bold()),
        Span::raw(" | Round: "),
        Span::raw(app.round_number.to_string()).bold(),
        Span::raw(format!(" ({})", duration)),
    ]);

    if app.has_updates {
        text.push_span(Span::raw(" | "));
        text.push_span(Span::raw("Has changes").yellow().rapid_blink())
    }

    let paragraph = Paragraph::new(text)
        .alignment(Alignment::Left)
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, rect);
}

pub fn format_vote(vote: &Vote, own_vote: &Option<VoteData>) -> Span<'static> {
    match vote {
        Vote::Missing => Span::raw("-").style(Style::new().red()),
        Vote::Hidden => Span::raw("#").style(Style::new().green()),
        Vote::Revealed(data) => match data {
            VoteData::Number(n) => {
                let color = if let Some(VoteData::Number(n2)) = own_vote {
                    if *n2 == *n {
                        Style::new().green()
                    } else if *n2 < *n {
                        Style::new().light_blue()
                    } else {
                        Style::new().yellow()
                    }
                } else {
                    Style::new()
                };
                Span::raw(n.to_string()).style(color)
            }
            VoteData::Special(t) => {
                if t.trim().is_empty() {
                    Span::raw("-").style(Style::new().red())
                } else {
                    Span::raw(t.clone())
                }
            }
        },
    }
}

