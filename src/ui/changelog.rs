use crossterm::event::{KeyCode, KeyEvent};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use regex::Regex;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::prelude::*;
use ratatui::widgets::{Paragraph, ScrollDirection, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap};
use semver::Version;
use crate::app::{App, AppResult};
use crate::ui::{footer_entries, FooterEntry, Page, UIAction, UiPage};
use crate::ui::changelog::changelog_parser::parse_changelog;

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
            .constraints([
                Constraint::Fill(1),
                Constraint::Length(3),
            ])
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
            KeyCode::Char(c) if c == 'v' || c == '-' || c == 'h' || c.is_ascii_digit() || c == 'u' => {
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
            _ => UIAction::Continue
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
            FooterEntry { name: "Vote".to_string(), shortcut: 'V', highlight: app.has_updates },
            FooterEntry { name: "↑".to_string(), shortcut: '↑', highlight: false },
            FooterEntry { name: "↓".to_string(), shortcut: '↓', highlight: false },
            FooterEntry { name: "Quit".to_string(), shortcut: 'Q', highlight: false },
        ];
        if self.version_from.is_some() {
            entries.insert(3, FooterEntry { name: "Toggle filter".to_string(), shortcut: 'T', highlight: false });
        }

        let footer = footer_entries(entries);
        frame.render_widget(footer, rect);
    }

    fn render_changelog_content(&mut self, _app: &mut App, rect: Rect, frame: &mut Frame) {
        let content_to_parse = self.filter_changelog_by_version();
        let content = self.format_changelog(&content_to_parse, rect.width);
        let content_length = content.len().saturating_sub(rect.height.saturating_sub(2) as usize);
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
            &mut self.scroll_state
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

        sections.iter()
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
    mod tests {
        use super::*;

        #[test]
        fn test_parse_empty_changelog() {
            let current = Version::parse("1.0.0").unwrap();
            let target = Version::parse("2.0.0").unwrap();
            assert!(parse_changelog("", &current, &target).is_empty());
        }

        #[test]
        fn test_parse_version_in_range() {
            let content = r#"## [1.2.0]
Some changes here
More changes
"#;
            let current = Version::parse("1.1.0").unwrap();
            let target = Version::parse("1.2.0").unwrap();
            let sections = parse_changelog(content, &current, &target);
            assert_eq!(sections.len(), 1);
            assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
            assert_eq!(
                sections[0].content,
                "## [1.2.0]\nSome changes here\nMore changes\n"
            );
        }

        #[test]
        fn test_parse_multiple_versions_filtering() {
            let content = r#"## [1.3.0]
Version 1.3.0 changes
## [1.2.0]
Version 1.2.0 changes
## [1.1.0]
Version 1.1.0 changes
## [1.0.0]
Version 1.0.0 changes
"#;
            let current = Version::parse("1.1.0").unwrap();
            let target = Version::parse("1.2.0").unwrap();
            let sections = parse_changelog(content, &current, &target);
            assert_eq!(sections.len(), 1);
            assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
        }

        #[test]
        fn test_ignore_versions_outside_range() {
            let content = r#"## [2.0.0]
Future version
## [1.2.0]
Current target
## [1.0.0]
Old version
"#;
            let current = Version::parse("1.1.0").unwrap();
            let target = Version::parse("1.2.0").unwrap();
            let sections = parse_changelog(content, &current, &target);
            assert_eq!(sections.len(), 1);
            assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
        }

        #[test]
        fn test_preserve_section_formatting() {
            let content = r#"## [1.2.0]
### Features
- Feature 1
- Feature 2

### Bug Fixes
- Fix 1
"#;
            let current = Version::parse("1.1.0").unwrap();
            let target = Version::parse("1.2.0").unwrap();
            let sections = parse_changelog(content, &current, &target);
            assert_eq!(sections[0].content, content);
        }

        #[test]
        fn test_version_filtering() {
            let sample_changelog = r#"## [0.5.0]
Version 0.5.0 changes
## [0.4.0]
Version 0.4.0 changes
## [0.3.0]
Version 0.3.0 changes
"#;

            let filtered_sections = parse_changelog(
                sample_changelog,
                &Version::parse("0.4.0").unwrap(),
                &Version::parse("999.999.999").unwrap()
            );

            assert_eq!(filtered_sections.len(), 1);
            assert_eq!(filtered_sections[0].version, Version::parse("0.5.0").unwrap());

            let all_sections = parse_changelog(
                sample_changelog,
                &Version::parse("0.0.0").unwrap(),
                &Version::parse("999.999.999").unwrap()
            );

            assert_eq!(all_sections.len(), 3);
        }

    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::create_test_app;
    use crate::ui::tests::{tick, send_input};
    use crate::web::client::tests::LocalMockPokerClient;
    use insta::assert_snapshot;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use crossterm::event::KeyCode;
    #[test]
    fn test_parse_changelog_formatting() {
        let page = ChangelogPage {
            scroll_state: ScrollbarState::default(),
            scroll: 0,
            content_length: 0,
            version_from: None,
            filter_version: false,
            changelog_content: CHANGELOG_RAW,
        };

        let markdown = r#"## [0.5.0](https://github.com/ja-ko/ppoker/compare/v0.4.2...v0.5.0) (2025-05-11)


### Features

* **ui:** add cursor navigation and editing support in text input ([4c823a3](https://github.com/ja-ko/ppoker/commit/4c823a395d0aacd55c6ecafacc4b0dfb9d072bea)), closes [#61](https://github.com/ja-ko/ppoker/issues/61)
* **ui:** sanitize input strings across voting UI ([9acb561](https://github.com/ja-ko/ppoker/commit/9acb5611143d01f19c5a6fa22dbf337299c24c34)), closes [#59](https://github.com/ja-ko/ppoker/issues/59)
* **update:** add binary backup support during updates ([3069818](https://github.com/ja-ko/ppoker/commit/306981862166eafdefb0c43f0e1f9b3bd3c62ab5))
* **update:** add changelog parsing and display for updates ([03a1cab](https://github.com/ja-ko/ppoker/commit/03a1cab3097dd41066023e4a9b29c910c37bbbd8))
* **update:** add rich terminal rendering for changelog display ([2018401](https://github.com/ja-ko/ppoker/commit/2018401b9a60d592bfd8d737baefa33d6ede32e5))


### Bug Fixes

* cursor not moving right on right press. ([6247234](https://github.com/ja-ko/ppoker/commit/6247234fa77dd7c536d44f1e886131b029ea5e7a))
* **ui:** correct cursor position in input box rendering ([48be407](https://github.com/ja-ko/ppoker/commit/48be407b02eff6778687275d65bb9a00e8e16601)), closes [#60](https://github.com/ja-ko/ppoker/issues/60)
* **ui:** fix a crash that occurred when navigating right through multibyte character ([094114d](https://github.com/ja-ko/ppoker/commit/094114dcab0d21628a043cc9a8399b4cbbf83004))
"#;

        let lines = page.format_changelog(markdown, 80);

        assert!(lines.len() > 0, "Expected non-empty lines");

        let heading_line_index = lines.iter().position(|line| {
            line.spans.iter().any(|span| span.content.contains("0.5.0"))
        }).expect("Heading line not found");

        let heading_span = lines[heading_line_index].spans.iter()
            .find(|span| span.content.contains("0.5.0"))
            .expect("Heading span not found");

        assert!(heading_span.style.fg.is_some(), "Heading should have foreground color");
        assert_eq!(heading_span.style.fg.unwrap(), Color::Cyan, "Heading should be cyan");
        assert!(heading_span.style.add_modifier.contains(Modifier::BOLD), "Heading should be bold");
        assert!(heading_span.style.add_modifier.contains(Modifier::UNDERLINED), "Heading should be underlined");

        let features_line_index = lines.iter().position(|line| {
            line.spans.iter().any(|span| span.content.contains("Features"))
        }).expect("Features line not found");

        let features_span = lines[features_line_index].spans.iter()
            .find(|span| span.content.contains("Features"))
            .expect("Features span not found");

        assert!(features_span.style.add_modifier.contains(Modifier::BOLD), "Features should be bold");

        let commit_line_index = lines.iter().position(|line| {
            line.spans.iter().any(|span| span.content.contains("4c823a3"))
        }).expect("Commit line not found");

        let commit_span = lines[commit_line_index].spans.iter()
            .find(|span| span.content.contains("4c823a3"))
            .expect("Commit span not found");

        assert!(commit_span.style.fg.is_some(), "Commit hash should have foreground color");
        assert_eq!(commit_span.style.fg.unwrap(), Color::Yellow, "Commit hash should be yellow");

        let strong_line_index = lines.iter().position(|line| {
            line.spans.iter().any(|span| span.content.contains("ui:"))
        }).expect("Strong text line not found");

        let strong_span = lines[strong_line_index].spans.iter()
            .find(|span| span.content.contains("ui:"))
            .expect("Strong span not found");

        assert!(strong_span.style.add_modifier.contains(Modifier::BOLD), "Strong text should be bold");

        let last_line = lines.last().expect("No last line found");
        assert!(last_line.spans[0].content.contains("─"), "Last line should be a separator");
        assert!(last_line.spans[0].style.add_modifier.contains(Modifier::DIM), "Separator should be dim");
    }

    #[test]
    fn test_changelog_page() {
        let mock_changelog = r#"## [0.5.0]
### Features
* Feature 1
* Feature 2

### Bug Fixes
* Fix 1
* Fix 2
"#;

        let mut page = ChangelogPage {
            scroll_state: ScrollbarState::default(),
            scroll: 0,
            content_length: 0,
            version_from: None,
            filter_version: false,
            changelog_content: mock_changelog,
        };
        let mut app = create_test_app(Box::new(LocalMockPokerClient::new("test")));
        let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();
        tick(&mut terminal, &mut page, &mut app);

        assert_snapshot!("changelog_page", terminal.backend());
    }

    #[test]
    fn test_changelog_filtering() {
        let mock_changelog = r#"## [1.0.0]
### Major Features
* Feature A
* Feature B
* Feature C

### Bug Fixes
* Fix A
* Fix B
* Fix C

## [0.9.0]
### Features
* Feature 1
* Feature 2
* Feature 3

### Bug Fixes
* Fix 1
* Fix 2
* Fix 3

## [0.8.0]
### Features
* Another Feature 1
* Another Feature 2
* Another Feature 3

### Bug Fixes
* Another Fix 1
* Another Fix 2
* Another Fix 3
"#;

        let mut page = ChangelogPage {
            scroll_state: ScrollbarState::default(),
            scroll: 0,
            content_length: 0,
            version_from: Some("0.9.0".to_string()),
            filter_version: false,
            changelog_content: mock_changelog,
        };
        let mut app = create_test_app(Box::new(LocalMockPokerClient::new("test")));
        let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();

        tick(&mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_filtering_full", terminal.backend());

        send_input(KeyCode::Char('t'), &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_filtering_filtered", terminal.backend());

        send_input(KeyCode::Char('t'), &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_filtering_full", terminal.backend());
    }

    #[test]
    fn test_changelog_scrolling() {
        let large_mock_changelog = r#"## [1.0.0]
### Major Features
* Feature A
* Feature B
* Feature C
* Feature D
* Feature E

### Bug Fixes
* Fix A
* Fix B
* Fix C
* Fix D
* Fix E

## [0.9.0]
### Features
* Feature 1
* Feature 2
* Feature 3
* Feature 4
* Feature 5

### Bug Fixes
* Fix 1
* Fix 2
* Fix 3
* Fix 4
* Fix 5

## [0.8.0]
### Features
* Another Feature 1
* Another Feature 2
* Another Feature 3
* Another Feature 4
* Another Feature 5

### Bug Fixes
* Another Fix 1
* Another Fix 2
* Another Fix 3
* Another Fix 4
* Another Fix 5

## [0.7.0]
### Features
* More Feature 1
* More Feature 2
* More Feature 3
* More Feature 4
* More Feature 5

### Bug Fixes
* More Fix 1
* More Fix 2
* More Fix 3
* More Fix 4
* More Fix 5
"#;

        let mut page = ChangelogPage {
            scroll_state: ScrollbarState::default(),
            scroll: 0,
            content_length: 0,
            version_from: None,
            filter_version: false,
            changelog_content: large_mock_changelog,
        };
        let mut app = create_test_app(Box::new(LocalMockPokerClient::new("test")));
        let mut terminal = Terminal::new(TestBackend::new(80, 30)).unwrap();

        tick(&mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_initial", terminal.backend());

        send_input(KeyCode::Down, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_down_1", terminal.backend());

        send_input(KeyCode::Down, &mut terminal, &mut page, &mut app);
        send_input(KeyCode::Down, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_down_3", terminal.backend());

        // Try scrolling past bottom boundary
        for _ in 0..100 {
            send_input(KeyCode::Down, &mut terminal, &mut page, &mut app);
        }
        assert_snapshot!("changelog_scrolling_past_bottom", terminal.backend());

        // Scroll up multiple times
        send_input(KeyCode::Up, &mut terminal, &mut page, &mut app);
        send_input(KeyCode::Up, &mut terminal, &mut page, &mut app);
        send_input(KeyCode::Up, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_up_3", terminal.backend());

        // Try scrolling past top boundary
        for _ in 0..100 {
            send_input(KeyCode::Up, &mut terminal, &mut page, &mut app);
        }
        assert_snapshot!("changelog_scrolling_past_top", terminal.backend());

        // Test PageDown
        send_input(KeyCode::PageDown, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_page_down", terminal.backend());

        // Test PageUp
        send_input(KeyCode::PageUp, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_page_up", terminal.backend());

        // Test End key (should go to bottom)
        send_input(KeyCode::End, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_end", terminal.backend());

        // Test Home key (should go to top)
        send_input(KeyCode::Home, &mut terminal, &mut page, &mut app);
        assert_snapshot!("changelog_scrolling_home", terminal.backend());
    }
}
