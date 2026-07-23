use super::*;
use crate::ui::tests::{local_ui, send_input, tick};
use crossterm::event::KeyCode;
use insta::assert_snapshot;
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

    assert!(!lines.is_empty(), "Expected non-empty lines");

    let heading_line_index = lines
        .iter()
        .position(|line| line.spans.iter().any(|span| span.content.contains("0.5.0")))
        .expect("Heading line not found");

    let heading_span = lines[heading_line_index]
        .spans
        .iter()
        .find(|span| span.content.contains("0.5.0"))
        .expect("Heading span not found");

    assert!(
        heading_span.style.fg.is_some(),
        "Heading should have foreground color"
    );
    assert_eq!(
        heading_span.style.fg.unwrap(),
        Color::Cyan,
        "Heading should be cyan"
    );
    assert!(
        heading_span.style.add_modifier.contains(Modifier::BOLD),
        "Heading should be bold"
    );
    assert!(
        heading_span
            .style
            .add_modifier
            .contains(Modifier::UNDERLINED),
        "Heading should be underlined"
    );

    let features_line_index = lines
        .iter()
        .position(|line| {
            line.spans
                .iter()
                .any(|span| span.content.contains("Features"))
        })
        .expect("Features line not found");

    let features_span = lines[features_line_index]
        .spans
        .iter()
        .find(|span| span.content.contains("Features"))
        .expect("Features span not found");

    assert!(
        features_span.style.add_modifier.contains(Modifier::BOLD),
        "Features should be bold"
    );

    let commit_line_index = lines
        .iter()
        .position(|line| {
            line.spans
                .iter()
                .any(|span| span.content.contains("4c823a3"))
        })
        .expect("Commit line not found");

    let commit_span = lines[commit_line_index]
        .spans
        .iter()
        .find(|span| span.content.contains("4c823a3"))
        .expect("Commit span not found");

    assert!(
        commit_span.style.fg.is_some(),
        "Commit hash should have foreground color"
    );
    assert_eq!(
        commit_span.style.fg.unwrap(),
        Color::Yellow,
        "Commit hash should be yellow"
    );

    let strong_line_index = lines
        .iter()
        .position(|line| line.spans.iter().any(|span| span.content.contains("ui:")))
        .expect("Strong text line not found");

    let strong_span = lines[strong_line_index]
        .spans
        .iter()
        .find(|span| span.content.contains("ui:"))
        .expect("Strong span not found");

    assert!(
        strong_span.style.add_modifier.contains(Modifier::BOLD),
        "Strong text should be bold"
    );

    let last_line = lines.last().expect("No last line found");
    assert!(
        last_line.spans[0].content.contains("─"),
        "Last line should be a separator"
    );
    assert!(
        last_line.spans[0]
            .style
            .add_modifier
            .contains(Modifier::DIM),
        "Separator should be dim"
    );
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

    let page = ChangelogPage {
        scroll_state: ScrollbarState::default(),
        scroll: 0,
        content_length: 0,
        version_from: None,
        filter_version: false,
        changelog_content: mock_changelog,
    };
    let (mut page, mut app, mut terminal) = local_ui(page, (80, 30));
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

    let page = ChangelogPage {
        scroll_state: ScrollbarState::default(),
        scroll: 0,
        content_length: 0,
        version_from: Some("0.9.0".to_string()),
        filter_version: false,
        changelog_content: mock_changelog,
    };
    let (mut page, mut app, mut terminal) = local_ui(page, (80, 30));

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

    let page = ChangelogPage {
        scroll_state: ScrollbarState::default(),
        scroll: 0,
        content_length: 0,
        version_from: None,
        filter_version: false,
        changelog_content: large_mock_changelog,
    };
    let (mut page, mut app, mut terminal) = local_ui(page, (80, 30));

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
