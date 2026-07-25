use super::*;
use crate::app::tests::create_test_app;
use crate::web::client::tests::LocalTestTransport;
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::backend::TestBackend;

pub fn test_ui<P>(
    page: P,
    transport: LocalTestTransport,
    size: (u16, u16),
) -> (P, App, Terminal<TestBackend>) {
    (page, test_app(transport), test_terminal(size))
}

pub fn test_app(transport: LocalTestTransport) -> App {
    create_test_app(Box::new(transport))
}

pub fn test_terminal(size: (u16, u16)) -> Terminal<TestBackend> {
    Terminal::new(TestBackend::new(size.0, size.1)).unwrap()
}

pub fn local_ui<P>(page: P, size: (u16, u16)) -> (P, App, Terminal<TestBackend>) {
    test_ui(page, LocalTestTransport::new("test"), size)
}

pub fn local_app() -> App {
    test_app(LocalTestTransport::new("test"))
}

pub fn send_input<P: Page>(
    key: KeyCode,
    terminal: &mut Terminal<TestBackend>,
    page: &mut P,
    app: &mut App,
) {
    page.input(app, KeyEvent::new(key, KeyModifiers::empty()))
        .unwrap();
    tick(terminal, page, app);
}

pub fn send_input_with_modifiers<P: Page>(
    key: KeyCode,
    modifier: KeyModifiers,
    terminal: &mut Terminal<TestBackend>,
    page: &mut P,
    app: &mut App,
) {
    page.input(app, KeyEvent::new(key, modifier)).unwrap();
    tick(terminal, page, app);
}

pub fn send_text<P: Page>(
    text: &str,
    terminal: &mut Terminal<TestBackend>,
    page: &mut P,
    app: &mut App,
) {
    for character in text.chars() {
        send_input(KeyCode::Char(character), terminal, page, app);
    }
}

pub fn tick<P: Page>(terminal: &mut Terminal<TestBackend>, page: &mut P, app: &mut App) {
    app.update().unwrap();
    terminal.draw(|frame| page.render(app, frame)).unwrap();
}

#[test]
fn native_formatters_keep_long_names_shortcuts_and_duration_ranges_readable() {
    assert_eq!(
        trim_name(" 123456789012345678901234567890 "),
        "1234567890123456789012345"
    );
    assert_eq!(
        format_duration(&Duration::from_secs(2 * 3600 + 3 * 60)),
        "2 hours 3 minutes"
    );
    assert_eq!(
        format_duration(&Duration::from_secs(125)),
        "2 minutes 5 seconds"
    );
    assert_eq!(
        format_duration(&Duration::from_secs(100)),
        "1 minute 40 seconds"
    );
    assert_eq!(format_duration(&Duration::from_secs(59)), "59 seconds");

    let footer = footer_entries(vec![FooterEntry {
        name: "Exit".to_string(),
        shortcut: 'Q',
        highlight: false,
    }]);
    let mut terminal = test_terminal((30, 3));
    terminal
        .draw(|frame| frame.render_widget(footer, frame.area()))
        .unwrap();
    assert!(terminal.backend().to_string().contains("Exit (Q)"));
}
