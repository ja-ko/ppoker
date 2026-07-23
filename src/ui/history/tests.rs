use super::*;
use crate::ui::tests::{local_ui, send_input, test_app, test_terminal, tick};
use crate::web::client::tests::LocalTestTransport;
use insta::assert_snapshot;

fn play_round(
    app: &mut App,
    transport: &LocalTestTransport,
    users: [&str; 2],
    own_vote: &str,
    other_votes: [Option<&str>; 2],
) {
    app.vote(own_vote).unwrap();
    for (user, vote) in users
        .into_iter()
        .zip(other_votes)
        .filter_map(|(u, v)| v.map(|v| (u, v)))
    {
        transport.user_vote(user, Some(vote));
    }
    app.update().unwrap();
    app.reveal().unwrap();
    app.update().unwrap();
    app.restart().unwrap();
    app.update().unwrap();
}

#[test]
fn test_render_page() {
    let (mut page, mut app, mut terminal) = local_ui(HistoryPage::new(), (80, 20));
    tick(&mut terminal, &mut page, &mut app);

    assert_snapshot!("Empty history page", terminal.backend());
}

#[test]
fn test_render_page_with_history() {
    let mut page = HistoryPage::new();
    let transport = LocalTestTransport::new("Alice");

    // Add other players
    let bob_id = transport.add_user("Bob");
    let charlie_id = transport.add_user("Charlie");
    let mut app = test_app(transport.clone());
    app.update().unwrap();

    let users = [&*bob_id, &*charlie_id];
    play_round(&mut app, &transport, users, "5", [Some("3"), Some("8")]);
    play_round(&mut app, &transport, users, "13", [Some("?"), Some("8")]);
    play_round(&mut app, &transport, users, "3", [Some("5"), None]);

    // Render and snapshot the history page
    let mut terminal = test_terminal((90, 30));
    tick(&mut terminal, &mut page, &mut app);

    assert_snapshot!("History page with multiple rounds", terminal.backend());

    send_input(KeyCode::Down, &mut terminal, &mut page, &mut app);
    assert_snapshot!("History page after pressing down", terminal.backend());
}
