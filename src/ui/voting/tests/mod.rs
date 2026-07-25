use crate::models::{GamePhase, LogLevel, LogSource, Vote, VoteData};
use crate::ui::tests::{
    local_app, local_ui, send_input, send_input_with_modifiers, send_text, test_ui, tick,
};
use crate::ui::voting::InputMode;
use crate::ui::{Page, UIAction, UiPage, VotingPage};
use crate::web::client::tests::LocalTestTransport;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use insta::assert_snapshot;

fn input(page: &mut VotingPage, app: &mut crate::app::App, key: KeyCode) -> UIAction {
    page.input(app, KeyEvent::new(key, KeyModifiers::empty()))
        .unwrap()
}

#[test]
fn test_render_page() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));
    tick(&mut terminal, &mut page, &mut app);

    assert_snapshot!(terminal.backend(), @r#"
    "╭Overview──────────────────────────────────────────────────────────────────────╮"
    "│Name: test | Room: Planning Room | Server: wss://mocked | State: Playing |    │"
    "╰──────────────────────────────────────────────────────────────────────────────╯"
    "╭Players───────╮╭Your vote───────────────╮                                      "
    "│Name   Vote   ││                        │                                      "
    "│              ││                        │                                      "
    "│test   -      ││                        │                                      "
    "│              ││        ██████          │                                      "
    "│              ││                        │                                      "
    "│              ││                        │                                      "
    "│              ││                        │                                      "
    "│              │╰────────────────────────╯                                      "
    "│              │╭Log───────────────────────────────────────────────────────────╮"
    "│              ││[Server]: test joined the room                                │"
    "│              ││                                                              │"
    "│              ││                                                              │"
    "╰──────────────╯╰──────────────────────────────────────────────────────────────╯"
    "                                                                                "
    " Vote | Reveal | History | Name change | Chat | Quit                            "
    "                                                                                "
    "#);
}

#[test]
fn test_vote_reveal_restart() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));

    // Get initial room state
    tick(&mut terminal, &mut page, &mut app);
    assert!(!app.room().players.is_empty());

    // Send a number key event
    send_input(KeyCode::Char('5'), &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    // Verify vote was registered
    assert!(matches!(
        app.room().players[0].vote,
        Vote::Revealed(VoteData::Number(5))
    ));
    assert_snapshot!("After voting", terminal.backend());

    // Press 'r' to reveal
    send_input(KeyCode::Char('r'), &mut terminal, &mut page, &mut app);

    // Verify cards are revealed
    assert_eq!(app.room().phase, GamePhase::Revealed);
    assert_snapshot!("After reveal", terminal.backend());

    // Press 'r' again to restart
    send_input(KeyCode::Char('r'), &mut terminal, &mut page, &mut app);
    assert_snapshot!("Restart pending", terminal.backend());

    // Press Enter to confirm restart
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    // Verify game was reset
    assert_eq!(app.room().phase, GamePhase::Playing);
    assert!(matches!(app.room().players[0].vote, Vote::Missing));
    assert_snapshot!("After restart", terminal.backend());
}

#[test]
fn tui_dash_retracts_instead_of_playing_a_card() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));
    tick(&mut terminal, &mut page, &mut app);

    send_input(KeyCode::Char('5'), &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);
    assert_eq!(app.own_vote(), &Some(VoteData::Number(5)));

    send_input(KeyCode::Char('-'), &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    assert_eq!(app.own_vote(), &None);
    assert!(app
        .activity_log()
        .iter()
        .any(|entry| entry.message.contains("removed their card")));
}

#[test]
fn invalid_card_is_logged_without_terminating_input_path() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));
    tick(&mut terminal, &mut page, &mut app);

    send_input(KeyCode::Char('v'), &mut terminal, &mut page, &mut app);
    send_text("not-a-card", &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    assert_eq!(page.input_mode, InputMode::Menu);
    assert!(app.activity_log().iter().any(|entry| {
        entry.level == LogLevel::Error
            && entry.source == LogSource::Client
            && entry.message == "Card is not in the deck: not-a-card"
    }));
}

#[test]
fn stale_reset_confirmation_logs_invalid_state() {
    let mut page = VotingPage::new();
    let mut app = local_app();

    let mut revealed = app.room().clone();
    revealed.phase = GamePhase::Revealed;
    app.merge_update(revealed);
    page.input(
        &mut app,
        KeyEvent::new(KeyCode::Char('r'), KeyModifiers::empty()),
    )
    .unwrap();
    assert_eq!(page.input_mode, InputMode::ResetConfirm);

    let mut playing = app.room().clone();
    playing.phase = GamePhase::Playing;
    app.merge_update(playing);
    page.input(
        &mut app,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::empty()),
    )
    .unwrap();

    assert_eq!(page.input_mode, InputMode::Menu);
    assert!(app.activity_log().iter().any(|entry| {
        entry.level == LogLevel::Error
            && entry.message == "A new round can only be started after cards are revealed."
    }));
}

#[test]
fn native_input_modes_cover_navigation_and_every_auto_reveal_choice() {
    let mut page = VotingPage::new();
    let mut app = local_app();

    assert!(matches!(
        input(&mut page, &mut app, KeyCode::Char('u')),
        UIAction::ChangeView(UiPage::Changelog)
    ));
    assert!(app.has_seen_changelog);
    assert!(matches!(
        input(&mut page, &mut app, KeyCode::Char('n')),
        UIAction::Continue
    ));
    assert_eq!(page.input_mode, InputMode::Name);
    input(&mut page, &mut app, KeyCode::Enter);
    assert_eq!(page.input_mode, InputMode::Menu);

    page.input_mode = InputMode::RevealConfirm;
    input(&mut page, &mut app, KeyCode::Enter);
    assert_eq!(page.input_mode, InputMode::Menu);
    let mut room = app.room().clone();
    room.phase = GamePhase::Revealed;
    app.merge_update(room);
    page.input_mode = InputMode::ResetConfirm;
    input(&mut page, &mut app, KeyCode::Enter);
    assert_eq!(page.input_mode, InputMode::Menu);

    for mode in [InputMode::RevealConfirm, InputMode::ResetConfirm] {
        for key in [KeyCode::Char('n'), KeyCode::Esc] {
            page.input_mode = mode;
            assert!(matches!(
                input(&mut page, &mut app, key),
                UIAction::Continue
            ));
            assert_eq!(page.input_mode, InputMode::Menu);
        }
        page.input_mode = mode;
        assert!(matches!(
            input(&mut page, &mut app, KeyCode::Char('q')),
            UIAction::Quit
        ));
    }

    for key in [
        KeyCode::Char('y'),
        KeyCode::Enter,
        KeyCode::Char('r'),
        KeyCode::Char(' '),
    ] {
        page.input_mode = InputMode::AutoReveal;
        app.auto_reveal_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(3));
        assert!(matches!(
            input(&mut page, &mut app, key),
            UIAction::Continue
        ));
        assert_eq!(page.input_mode, InputMode::Menu);
        assert!(app.auto_reveal_at.is_none());
    }
    for key in [KeyCode::Char('n'), KeyCode::Esc] {
        page.input_mode = InputMode::AutoReveal;
        app.auto_reveal_at = Some(std::time::Instant::now());
        input(&mut page, &mut app, key);
        assert_eq!(page.input_mode, InputMode::Menu);
        assert!(app.auto_reveal_at.is_none());
    }
    page.input_mode = InputMode::AutoReveal;
    assert!(matches!(
        input(&mut page, &mut app, KeyCode::Char('q')),
        UIAction::Quit
    ));
}

#[test]
fn test_reveal_confirm_cancel() {
    let client = LocalTestTransport::new("test");
    client.add_user("other");
    let (mut page, mut app, mut terminal) = test_ui(VotingPage::new(), client, (80, 20));

    // Get initial room state
    tick(&mut terminal, &mut page, &mut app);
    assert_eq!(app.room().players.len(), 2);

    // Vote with local user
    send_input(KeyCode::Char('5'), &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    // Try to reveal
    send_input(KeyCode::Char('r'), &mut terminal, &mut page, &mut app);

    // Verify still in playing phase
    assert_eq!(app.room().phase, GamePhase::Playing);
    assert_snapshot!("Reveal confirmation", terminal.backend());

    // Cancel reveal
    send_input(KeyCode::Char('n'), &mut terminal, &mut page, &mut app);

    // Verify still in playing phase
    assert_eq!(app.room().phase, GamePhase::Playing);
    assert_snapshot!("After cancel", terminal.backend());
}

#[test]
fn test_spectators_voting_flow() {
    let client = LocalTestTransport::new("test");
    client.add_spectator("viewer");
    let (mut page, mut app, mut terminal) = test_ui(VotingPage::new(), client, (80, 25));

    // Get initial room state with spectator
    tick(&mut terminal, &mut page, &mut app);
    assert_snapshot!("Initial with spectator", terminal.backend());

    // Vote with local user
    send_input(KeyCode::Char('3'), &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);
    assert_snapshot!("After voting with spectator", terminal.backend());

    // Reveal cards
    send_input(KeyCode::Char('r'), &mut terminal, &mut page, &mut app);
    assert_snapshot!("After reveal with spectator", terminal.backend());
}

#[test]
fn test_chat_message() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));

    // Get initial state
    tick(&mut terminal, &mut page, &mut app);

    // Enter chat mode
    send_input(KeyCode::Char('c'), &mut terminal, &mut page, &mut app);

    // Type message
    send_text("Hello!", &mut terminal, &mut page, &mut app);
    assert_snapshot!("Before sending chat", terminal.backend());

    // Send message
    send_input(KeyCode::Enter, &mut terminal, &mut page, &mut app);

    // Verify message appears in log
    assert!(app
        .activity_log()
        .iter()
        .any(|entry| entry.message.contains("Hello!")));
    assert_snapshot!("After sending chat", terminal.backend());
}

#[test]
fn test_input_cancellation() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));

    // Get initial state
    tick(&mut terminal, &mut page, &mut app);

    page.pasted(&mut app, "ignored".to_string());
    assert_eq!(page.text_input.text(), "");

    // Test chat mode cancellation with Esc
    send_input(KeyCode::Char('c'), &mut terminal, &mut page, &mut app);
    page.pasted(&mut app, "pasted\n".to_string());
    assert_eq!(page.text_input.text(), "pasted");
    send_text("Test message", &mut terminal, &mut page, &mut app);
    send_input(KeyCode::Esc, &mut terminal, &mut page, &mut app);
    assert_eq!(page.input_mode, InputMode::Menu);
    assert_eq!(page.text_input.text(), "");

    // Test vote mode cancellation with Ctrl+C
    send_input(KeyCode::Char('5'), &mut terminal, &mut page, &mut app);
    send_input_with_modifiers(
        KeyCode::Char('c'),
        KeyModifiers::CONTROL,
        &mut terminal,
        &mut page,
        &mut app,
    );
    assert_eq!(page.input_mode, InputMode::Menu);
    assert_eq!(page.text_input.text(), "");
}

#[test]
fn test_quit_flow() {
    let (mut page, mut app, mut terminal) = local_ui(VotingPage::new(), (80, 20));

    // Get initial state
    tick(&mut terminal, &mut page, &mut app);
    assert_eq!(page.input_mode, InputMode::Menu);

    // Press ESC to trigger quit confirmation dialog
    send_input(KeyCode::Esc, &mut terminal, &mut page, &mut app);
    assert_eq!(page.input_mode, InputMode::QuitConfirm);
    assert_snapshot!("Quit confirmation dialog", terminal.backend());

    // Press 'N' to cancel quit
    send_input(KeyCode::Char('n'), &mut terminal, &mut page, &mut app);
    assert_eq!(page.input_mode, InputMode::Menu);
    assert_snapshot!("After canceling quit", terminal.backend());

    // Press 'q' again to confirm quit (this doesn't show a confirmation dialog)
    let result = page.input(
        &mut app,
        KeyEvent::new(KeyCode::Char('q'), KeyModifiers::empty()),
    );
    assert!(matches!(result, Ok(UIAction::Quit)));
}
