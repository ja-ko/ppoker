use crate::app::{App, AppResult};
use crate::ui::changelog::changelog_parser::parse_changelog;
use crate::ui::{footer_entries, FooterEntry, Page, UIAction, UiPage};
use crossterm::event::{KeyCode, KeyEvent};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use ratatui::layout::Rect;
use ratatui::prelude::*;
use ratatui::widgets::{
    Paragraph, ScrollDirection, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};
use ratatui::Frame;
use regex::Regex;
use semver::Version;

const CHANGELOG_RAW: &str = include_str!("../../CHANGELOG.md");
pub struct ChangelogPage {
    scroll_state: ScrollbarState,
    scroll: usize,
    content_length: usize,
    version_from: Option<String>,
    filter_version: bool,
    changelog_content: &'static str,
}

impl Page for ChangelogPage {
    fn render(&mut self, app: &mut App, frame: &mut Frame) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Fill(1), Constraint::Length(3)])
            .split(frame.area());

        let primary = chunks[0];
        let footer = chunks[1];

        self.render_changelog_content(app, primary, frame);
        self.render_footer(app, footer, frame)
    }

    fn input(&mut self, _app: &mut App, event: KeyEvent) -> AppResult<UIAction> {
        Ok(match event.code {
            KeyCode::Char('q') => UIAction::Quit,
            KeyCode::Esc => UIAction::ChangeView(UiPage::Voting),
            KeyCode::Char(c)
                if c == 'v' || c == '-' || c == 'h' || c.is_ascii_digit() || c == 'u' =>
            {
                UIAction::ChangeView(UiPage::Voting)
            }
            KeyCode::Char('t') => {
                self.filter_version = !self.filter_version;
                UIAction::Continue
            }
            KeyCode::Up | KeyCode::PageUp | KeyCode::Char('k') => {
                self.scroll_state.scroll(ScrollDirection::Backward);
                self.scroll = self.scroll.saturating_sub(1);
                UIAction::Continue
            }
            KeyCode::Down | KeyCode::PageDown | KeyCode::Char('j') => {
                if self.scroll < self.content_length {
                    self.scroll_state.scroll(ScrollDirection::Forward);
                    self.scroll = self.scroll.saturating_add(1);
                }
                UIAction::Continue
            }
            KeyCode::Home => {
                self.scroll_state.first();
                self.scroll = 0;
                UIAction::Continue
            }
            KeyCode::End => {
                self.scroll_state.last();
                self.scroll = self.content_length;
                UIAction::Continue
            }
            _ => UIAction::Continue,
        })
    }
}

impl ChangelogPage {
    pub fn new(version_from: Option<String>) -> Self {
        let filter_version = version_from.is_some();
        Self {
            scroll_state: ScrollbarState::default(),
            scroll: 0,
            content_length: 0,
            version_from,
            filter_version,
            changelog_content: CHANGELOG_RAW,
        }
    }

    fn render_footer(&mut self, app: &mut App, rect: Rect, frame: &mut Frame) {
        let mut entries = vec![
            FooterEntry {
                name: "Vote".to_string(),
                shortcut: 'V',
                highlight: app.has_updates,
            },
            FooterEntry {
                name: "↑".to_string(),
                shortcut: '↑',
                highlight: false,
            },
            FooterEntry {
                name: "↓".to_string(),
                shortcut: '↓',
                highlight: false,
            },
            FooterEntry {
                name: "Quit".to_string(),
                shortcut: 'Q',
                highlight: false,
            },
        ];
        if self.version_from.is_some() {
            entries.insert(
                3,
                FooterEntry {
                    name: "Toggle filter".to_string(),
                    shortcut: 'T',
                    highlight: false,
                },
            );
        }

        let footer = footer_entries(entries);
        frame.render_widget(footer, rect);
    }

    fn render_changelog_content(&mut self, _app: &mut App, rect: Rect, frame: &mut Frame) {
        let content_to_parse = self.filter_changelog_by_version();
        let content = self.format_changelog(&content_to_parse, rect.width);
        let content_length = content
            .len()
            .saturating_sub(rect.height.saturating_sub(2) as usize);
        self.content_length = content_length;
        self.scroll_state = self.scroll_state.content_length(content_length);

        let paragraph = Paragraph::new(content)
            .wrap(Wrap { trim: true })
            .scroll((self.scroll as u16, 0));

        frame.render_widget(paragraph, rect);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .begin_symbol(Some("↑"))
                .end_symbol(Some("↓")),
            rect,
            &mut self.scroll_state,
        );
    }

    fn filter_changelog_by_version(&self) -> String {
        if !self.filter_version || self.version_from.is_none() {
            return self.changelog_content.to_string();
        }

        let version_str = match &self.version_from {
            Some(v) => v,
            None => return self.changelog_content.to_string(),
        };

        let version_from = match Version::parse(version_str) {
            Ok(v) => v,
            Err(_) => return self.changelog_content.to_string(),
        };

        let target_version = Version::parse("999.999.999").unwrap();

        let sections = parse_changelog(self.changelog_content, &version_from, &target_version);

        if sections.is_empty() {
            return self.changelog_content.to_string();
        }

        sections
            .iter()
            .map(|section| section.content.clone())
            .collect::<Vec<String>>()
            .join("\n")
    }

    fn format_changelog<'a>(&self, content: &'a str, width: u16) -> Vec<Line<'a>> {
        let parser = Parser::new(content);
        let commit_regex = Regex::new(r"^[a-fA-F0-9]{7,40}$").unwrap();
        let mut lines: Vec<Line<'a>> = Vec::new();
        let mut current_line: Vec<Span<'a>> = Vec::new();
        let mut is_in_heading = false;
        let mut is_in_strong = false;

        for event in parser {
            match event {
                Event::Start(Tag::Heading { level, .. }) => {
                    if !current_line.is_empty() {
                        lines.push(Line::from(current_line));
                        current_line = Vec::new();
                    }
                    lines.push(Line::from(Vec::new())); // Add empty line before heading
                    is_in_heading = true;

                    if level == HeadingLevel::H2 {
                        // H2 headings are cyan, bold, and underlined
                        is_in_strong = true;
                    } else {
                        // Other headings are just bold
                        is_in_strong = true;
                    }
                }
                Event::End(TagEnd::Heading(_)) => {
                    lines.push(Line::from(current_line));
                    current_line = Vec::new();
                    is_in_heading = false;
                    is_in_strong = false;
                }
                Event::Start(Tag::Item) => {
                    current_line.push(Span::raw(" * "));
                }
                Event::End(TagEnd::Item) => {
                    lines.push(Line::from(current_line));
                    current_line = Vec::new();
                }
                Event::Start(Tag::Strong) => {
                    is_in_strong = true;
                }
                Event::End(TagEnd::Strong) => {
                    is_in_strong = false;
                }
                Event::Text(text) => {
                    let mut style = Style::default();

                    if is_in_heading && is_in_strong {
                        if is_in_heading {
                            // H2 headings are cyan, bold, and underlined
                            style = style.cyan().bold().underlined();
                        } else {
                            // Other headings and strong text are just bold
                            style = style.bold();
                        }
                    } else if is_in_strong {
                        style = style.bold();
                    }

                    if commit_regex.is_match(&text) {
                        // Commit hashes are yellow
                        style = style.yellow();
                    }

                    current_line.push(Span::styled(text, style));
                }
                Event::Code(text) => {
                    current_line.push(Span::raw(format!("`{}`", text)));
                }
                Event::HardBreak => {
                    lines.push(Line::from(current_line));
                    current_line = Vec::new();
                }
                _ => {}
            }
        }

        if !current_line.is_empty() {
            lines.push(Line::from(current_line));
        }

        // Add a separator line at the end
        let separator = "─".repeat(width as usize);
        lines.push(Line::from(Span::styled(separator, Style::default().dim())));

        lines
    }
}

mod changelog_parser {
    use regex::Regex;
    use semver::Version;

    #[derive(Debug, PartialEq)]
    pub struct ChangelogSection {
        pub version: Version,
        pub content: String,
    }

    /// Parse changelog content into sections, returning only versions between current_version (exclusive) and target_version (inclusive)
    ///
    /// # Arguments
    /// * `content` - The changelog content to parse
    /// * `from` - The current version (exclusive)
    /// * `until` - The target version (inclusive)
    ///
    /// # Returns
    /// A vector of changelog sections for versions between current_version and target_version
    pub fn parse_changelog(
        content: &str,
        from: &Version,
        until: &Version,
    ) -> Vec<ChangelogSection> {
        if from >= until {
            return vec![];
        }

        let version_re = Regex::new(r"##\s+\[([0-9.]+)]").unwrap();
        let mut sections = Vec::new();
        let mut current_version_str = String::new();
        let mut current_section = String::new();

        for line in content.lines() {
            if let Some(cap) = version_re.captures(line) {
                // When we find a new version header, save the previous section if valid and in range
                section_completed(
                    from,
                    until,
                    &mut sections,
                    &mut current_version_str,
                    current_section,
                );
                // Start a new section
                current_version_str = cap[1].to_string();
                current_section = String::from(line) + "\n";
            } else if !current_version_str.is_empty() {
                current_section.push_str(line);
                current_section.push('\n');
            }
        }

        // Handle the last section
        section_completed(
            from,
            until,
            &mut sections,
            &mut current_version_str,
            current_section,
        );

        sections
    }

    fn section_completed(
        current_version: &Version,
        target_version: &Version,
        sections: &mut Vec<ChangelogSection>,
        current_version_str: &mut String,
        current_section: String,
    ) {
        if !current_section.is_empty() && !current_version_str.is_empty() {
            if let Ok(version) = Version::parse(&current_version_str) {
                if version > *current_version && version <= *target_version {
                    sections.push(ChangelogSection {
                        version,
                        content: current_section,
                    });
                }
            }
        }
    }

    #[cfg(test)]
    mod tests;
}

#[cfg(test)]
mod tests;
