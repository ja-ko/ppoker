use std::collections::HashMap;
use std::ops::{AddAssign, DerefMut};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Frame;
use ratatui::prelude::*;
use ratatui::widgets::{Bar, BarChart, BarGroup, Block, BorderType, Cell, List, ListDirection, ListItem, ListState, Paragraph, Row, Table, Wrap};
use tui_big_text::{BigText, PixelSize};

use crate::app::{App, AppResult};
use crate::models::{GamePhase, LogLevel, UserType, Vote, VoteData};
use crate::tui::UiPage;
use crate::ui::{Page, UIAction};

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum InputMode {
    Menu,
    Vote,
    Name,
    Chat,
    RevealConfirm,
    ResetConfirm,
}

pub struct VotingPage {
    pub input_mode: InputMode,
    pub input_buffer: Option<String>,
    last_phase: GamePhase
}

impl VotingPage {
    pub fn new() -> Self {
        Self {
            input_mode: InputMode::Menu,
            input_buffer: None,
            last_phase: GamePhase::Playing,
        }
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
        self.input_buffer = Some(default);
    }

    pub fn confirm_input(&mut self, app: &mut App) -> AppResult<()> {
        let buffer = self.input_buffer.as_ref().map(|b| b.trim().replace('\n', ""));
        match self.input_mode {
            InputMode::Vote if app.room.phase == GamePhase::Playing => {
                if let Some(input_buffer) = &buffer {
                    let vote = input_buffer.clone();
                    app.vote(vote.as_str())?;
                }
                self.cancel_input();
            }
            InputMode::Name => {
                if let Some(input_buffer) = &buffer {
                    let name = input_buffer.clone();
                    app.rename(name)?;
                }
                self.cancel_input();
            }
            InputMode::Chat => {
                if let Some(input_buffer) = &buffer {
                    let name = input_buffer.clone();
                    app.chat(name)?;
                }
                self.cancel_input();
            }
            _ => {}
        }

        Ok(())
    }

    pub fn cancel_input(&mut self) {
        self.input_mode = InputMode::Menu;
        self.input_buffer = None;
    }

    fn render_votes(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box_colored("Players", colored_box_style(app), rect, frame);

        let mut longest_name: usize = 0;

        let mut players = app.room.players.clone();
        if app.room.phase == GamePhase::Revealed {
            fn vote_rank(vote: &Vote) -> i32 {
                match vote {
                    Vote::Missing => { 9999 }
                    Vote::Hidden => { 9999 }
                    Vote::Revealed(VoteData::Number(n)) => { *n as i32 }
                    Vote::Revealed(VoteData::Special(_)) => { 999 }
                }
            }
            players.sort_by(|p, p2| {
                vote_rank(&p.vote).cmp(&vote_rank(&p2.vote))
            })
        }

        let rows: Vec<Row> = players.iter().map(|player| {
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
        }).collect();

        let table = Table::new(rows, [Constraint::Length(longest_name as u16), Constraint::Fill(1)])
            .column_spacing(3)
            .header(
                Row::new(vec!["Name", "Vote"])
                    .style(Style::new().bold())
                    .bottom_margin(1)
            );

        frame.render_widget(table, rect);
    }

    fn render_own_vote(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let constraints = if app.room.phase == GamePhase::Revealed {
            [
                Constraint::Length(26),
                Constraint::Length((app.room.deck.len() * 3) as u16),
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

        if app.room.phase == GamePhase::Revealed {
            let inner = render_box_colored("Vote distribution", colored_box_style(app), bar_chart, frame);

            let mut cards = HashMap::new();
            for player in &app.room.players {
                let card = format!("{}", player.vote);
                cards.entry(card).or_insert(0).deref_mut().add_assign(1);
            }

            let cards: Vec<_> = app.room.deck.iter().map(|card| {
                Bar::default()
                    .text_value(card.clone())
                    .value(*cards.get(card).unwrap_or(&0))
            }).collect();

            let chart = BarChart::default()
                .bar_width(2)
                .bar_gap(1)
                .data(BarGroup::default().bars(cards.as_slice()));

            frame.render_widget(chart, inner);

            let inner = render_box_colored("Average vote", colored_box_style(app), average, frame);
            let average = crate::ui::voting::average_votes(app);
            let text = BigText::builder()
                .pixel_size(PixelSize::Full)
                .style(Style::new().light_blue())
                .alignment(Alignment::Center)
                .lines(vec![format!("{:.1}", average).into()])
                .build().expect("Failed to build Text widget");
            frame.render_widget(text, inner);
        }

        let inner = render_box_colored("Your vote", colored_box_style(app), small_box, frame);

        let (color, text) = if let Some(vote) = &app.vote {
            (Style::new().green(), vote.to_string())
        } else {
            (Style::new().red(), "-".to_owned())
        };

        let text = BigText::builder()
            .pixel_size(PixelSize::Full)
            .style(color)
            .alignment(Alignment::Center)
            .lines(vec![text.into()])
            .build().expect("Failed to build text widget");
        frame.render_widget(text, inner);
    }

    fn render_overview(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box("Overview", rect, frame);

        let name = crate::ui::voting::trim_name(app.name.as_str());
        let state_color = if app.room.phase == GamePhase::Playing {
            Style::new().yellow()
        } else {
            Style::new().light_blue()
        };

        let text = Line::from(vec![
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
        ]);

        let paragraph = Paragraph::new(text)
            .alignment(Alignment::Left)
            .wrap(Wrap { trim: true });
        frame.render_widget(paragraph, rect);
    }

    fn render_log(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let rect = render_box_colored("Log", colored_box_style(app), rect, frame);

        let entries: Vec<ListItem> = app.log.iter().map(|logentry| {
            let color = match logentry.level {
                LogLevel::Chat => { Style::new().light_blue() }
                LogLevel::Info => { Style::new() }
                LogLevel::Error => { Style::new().red() }
            };
            let prefix = match logentry.level {
                LogLevel::Chat => { String::from("") }
                _ => {
                    format!("[{:?}]: ", logentry.source)
                }
            };
            ListItem::new(format!("{}{}", prefix, logentry.message)).style(color)
        }).collect();

        let mut state = ListState::default().with_offset(entries.len().saturating_sub(rect.height as usize));
        let list = List::new(entries)
            .direction(ListDirection::TopToBottom);

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
                let mut spans: Vec<Span> = app.room.deck.iter().flat_map(|item| {
                    vec![
                        Span::raw(" "),
                        Span::raw(item.clone()),
                        Span::raw(" |"),
                    ]
                }).collect();

                spans.insert(0, Span::raw("   Possible values:"));
                spans.remove(spans.len() - 1);


                let possible_values = Paragraph::new(vec![Line::from(""), Line::from(spans)]).style(Style::new().gray());
                frame.render_widget(possible_values, layout[1]);
            }
            InputMode::Name => {
                self.render_text_input("Rename", rect, frame);
            }
            InputMode::Chat => {
                self.render_text_input("Chat", rect, frame);
            }
            InputMode::RevealConfirm => {
                render_confirmation_box("Not everyone has voted yet. Confirm you want to reveal the cards?", rect, frame);
            }
            InputMode::ResetConfirm => {
                render_confirmation_box("Confirm you want to reset the game?", rect, frame);
            }
            InputMode::Menu => {
                let entries = if app.room.phase == GamePhase::Playing {
                    vec!["Vote", "Reveal", "Name change", "Chat", "Quit"]
                } else {
                    vec!["Restart", "Name change", "Chat", "Quit"]
                };

                let mut spans: Vec<Span> = entries.iter().flat_map(|item| {
                    let (first, remaining) = item.split_at(1);
                    vec![
                        Span::raw(" "),
                        Span::styled(first, Style::default().add_modifier(Modifier::BOLD).add_modifier(Modifier::UNDERLINED)),
                        Span::raw(remaining),
                        Span::raw(" |"),
                    ]
                }).collect();
                spans.remove(spans.len() - 1);

                let paragraph = Paragraph::new(vec![Line::from(""), Line::from(spans)]);
                frame.render_widget(paragraph, rect);
            }
        }
    }

    fn render_text_input(&mut self, title: &str, rect: Rect, frame: &mut Frame) {
        let rect = render_box(title, rect, frame);
        let buffer = self.input_buffer.as_ref().map_or("", |buffer| buffer.as_str());
        let text_buffer = Paragraph::new(buffer);
        frame.render_widget(text_buffer, rect);
        frame.set_cursor(
            rect.x + buffer.len() as u16,
            rect.y,
        );
    }
}

impl Page for VotingPage {
    fn render(&mut self, app: &mut App, frame: &mut Frame) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Fill(1),
                Constraint::Length(3)
            ])
            .split(frame.size());

        let header = chunks[0];
        let primary = chunks[1];
        let footer = chunks[2];

        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(30),
                Constraint::Min(26),
            ]).split(primary);

        let left_side = chunks[0];
        let right_side = chunks[1];

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(9),
                Constraint::Fill(1),
            ]).split(right_side);

        let vote_view = chunks[0];
        let log = chunks[1];

        if app.room.phase != self.last_phase {
            if self.input_mode != InputMode::Name {
                self.input_mode = InputMode::Menu;
            }
            self.last_phase = app.room.phase;
        }

        self.render_own_vote(app, vote_view, frame);
        self.render_log(app, log, frame);
        self.render_votes(app, left_side, frame);
        self.render_overview(app, header, frame);
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
                    KeyCode::Char('-') => {
                        self.change_mode(InputMode::Vote, String::from("-"), app)
                    }
                    KeyCode::Char('v') => {
                        self.change_mode(InputMode::Vote, String::new(), app)
                    }
                    KeyCode::Char('c') if !event.modifiers.contains(KeyModifiers::CONTROL) => {
                        self.change_mode(InputMode::Chat, String::new(), app)
                    }
                    KeyCode::Char('n') => {
                        self.change_mode(InputMode::Name, app.name.clone(), app)
                    }
                    KeyCode::Char('l') => {
                        return Ok(UIAction::ChangeView(UiPage::Log));
                    }
                    KeyCode::Char('r') => {
                        if app.room.phase == GamePhase::Playing {
                            if app.room.players.iter().any(|p| p.user_type != UserType::Spectator && p.vote == Vote::Missing) {
                                self.input_mode = InputMode::RevealConfirm;
                            } else {
                                app.reveal()?;
                            }
                        } else {
                            self.input_mode = InputMode::ResetConfirm;
                        }
                    }
                    _ => {}
                }
            }
            InputMode::Vote | InputMode::Name | InputMode::Chat => {
                match event.code {
                    KeyCode::Esc => {
                        self.cancel_input();
                    }

                    KeyCode::Enter => {
                        self.confirm_input(app)?;
                    }

                    KeyCode::Backspace => {
                        if let Some(input_buffer) = &mut self.input_buffer {
                            input_buffer.pop();
                        }
                    }

                    KeyCode::Char(c) => {
                        if let Some(input_buffer) = &mut self.input_buffer {
                            input_buffer.push(c);
                        }
                    }
                    _ => {}
                }
            }
            InputMode::ResetConfirm => {
                match event.code {
                    KeyCode::Char('y') | KeyCode::Enter => {
                        app.restart()?;
                        self.input_mode = InputMode::Menu;
                    }
                    KeyCode::Char('n') | KeyCode::Esc => { self.input_mode = InputMode::Menu; }
                    KeyCode::Char('q') => { return Ok(UIAction::Quit); }
                    _ => {}
                }
            }
            InputMode::RevealConfirm => {
                match event.code {
                    KeyCode::Char('y') | KeyCode::Enter => {
                        app.reveal()?;
                        self.input_mode = InputMode::Menu;
                    }
                    KeyCode::Char('n') | KeyCode::Esc => { self.input_mode = InputMode::Menu; }
                    KeyCode::Char('q') => { return Ok(UIAction::Quit); }
                    _ => {}
                }
            }
        }
        Ok(UIAction::Continue)
    }

    fn pasted(&mut self, _app: &mut App, text: String) {
        match self.input_mode {
            InputMode::Chat | InputMode::Vote | InputMode::Name => {
                if let Some(input_buffer) = &mut self.input_buffer {
                    input_buffer.push_str(text.as_str());
                }
            }
            _ => {}
        }
    }
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

fn colored_box_style(app: &App) -> Style {
    match app.room.phase {
        GamePhase::Playing => { Style::new().white() }
        GamePhase::Revealed => { Style::new().light_blue() }
    }
}

fn render_box(title: &str, rect: Rect, frame: &mut Frame) -> Rect {
    render_box_colored(title, Style::new().white(), rect, frame)
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

fn format_vote(vote: &Vote, own_vote: &Option<VoteData>) -> Span<'static> {
    match vote {
        Vote::Missing => { Span::raw("-").style(Style::new().red()) }
        Vote::Hidden => { Span::raw("#").style(Style::new().green()) }
        Vote::Revealed(data) => {
            match data {
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
            }
        }
    }
}

fn average_votes(app: &mut App) -> f32 {
    let mut sum = 0f32;
    let mut count = 0f32;
    for player in &app.room.players {
        if let Vote::Revealed(VoteData::Number(n)) = player.vote {
            sum += n as f32;
            count += 1f32;
        }
    }
    sum / count
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
