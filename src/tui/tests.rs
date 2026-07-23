use super::*;
use crate::ui::tests::local_app;
use crossterm::event::{KeyCode, KeyModifiers};
use insta::assert_snapshot;
use ratatui::backend::TestBackend;

fn create_test_tui() -> (Tui<TestBackend>, App) {
    let terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    let events = EventHandler::new(100);
    let tui = Tui::new(terminal, events, Config::default());
    (tui, local_app())
}

/// Helper function to handle key press, assert current page, and draw app
fn press_key_and_assert(
    tui: &mut Tui<TestBackend>,
    app: &mut App,
    key_code: KeyCode,
    expected_page: UiPage,
) {
    tui.handle_key(KeyEvent::new(key_code, KeyModifiers::empty()), app)
        .unwrap();
    assert_eq!(tui.current_page, expected_page);
    tui.draw(app).unwrap();
}

#[test]
fn test_page_switching() {
    let (mut tui, mut app) = create_test_tui();

    // Initially should be on voting page
    assert_eq!(tui.current_page, UiPage::Voting);
    tui.draw(&mut app).unwrap();
    assert_snapshot!("initial_voting_page", tui.terminal.backend());

    // Switch to history page with 'h'
    press_key_and_assert(&mut tui, &mut app, KeyCode::Char('h'), UiPage::History);
    assert_snapshot!("switched_to_history", tui.terminal.backend());

    // Switch back to voting page with 'v'
    // This is done because you can only switch to the log page from the voting page
    press_key_and_assert(&mut tui, &mut app, KeyCode::Char('v'), UiPage::Voting);

    // Switch back history
    press_key_and_assert(&mut tui, &mut app, KeyCode::Char('h'), UiPage::History);
    // Go back to voting using `ESC`
    press_key_and_assert(&mut tui, &mut app, KeyCode::Esc, UiPage::Voting);

    // Switch to log page with 'l'
    press_key_and_assert(&mut tui, &mut app, KeyCode::Char('l'), UiPage::Log);
    assert!(tui
        .terminal
        .backend()
        .to_string()
        .contains("Toggle target selector"));

    // Switch back to voting page with 'l'
    press_key_and_assert(&mut tui, &mut app, KeyCode::Char('l'), UiPage::Voting);
    assert_snapshot!("back_to_voting", tui.terminal.backend());
}
