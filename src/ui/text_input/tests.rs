use super::*;
use crossterm::event::KeyModifiers;

fn press(input: &mut TextInput, code: KeyCode) {
    input.handle_input(&KeyEvent::new(code, KeyModifiers::empty()));
}

fn press_ctrl(input: &mut TextInput, code: KeyCode) {
    input.handle_input(&KeyEvent::new(code, KeyModifiers::CONTROL));
}

fn type_text(input: &mut TextInput, text: &str) {
    for character in text.chars() {
        press(input, KeyCode::Char(character));
    }
}

fn text_input(text: &str) -> TextInput {
    let mut input = TextInput::new();
    type_text(&mut input, text);
    input
}

#[test]
fn test_basic_input() {
    let mut input = TextInput::new();
    press(&mut input, KeyCode::Char('H'));
    assert_eq!(input.input_buffer, "H");
    assert_eq!(input.cursor_position, 1);
    type_text(&mut input, "ello");
    assert_eq!(input.input_buffer, "Hello");
    assert_eq!(input.cursor_position, 5);
}

#[test]
fn test_cursor_movement() {
    let mut input = text_input("Hello World");
    assert_eq!(input.cursor_position, 11);
    for (key, position) in [
        (KeyCode::Left, 10),
        (KeyCode::Left, 9),
        (KeyCode::Right, 10),
        (KeyCode::Right, 11),
    ] {
        press(&mut input, key);
        assert_eq!(input.cursor_position, position);
    }
    for _ in 0..15 {
        press(&mut input, KeyCode::Left);
    }
    assert_eq!(
        input.cursor_position, 0,
        "Cursor should stop at left boundary"
    );
    for _ in 0..15 {
        press(&mut input, KeyCode::Right);
    }
    assert_eq!(
        input.cursor_position, 11,
        "Cursor should stop at right boundary"
    );
    press(&mut input, KeyCode::Home);
    assert_eq!(input.cursor_position, 0);
    press(&mut input, KeyCode::End);
    assert_eq!(input.cursor_position, 11);
}

#[test]
fn test_utf8_navigation() {
    let mut input = text_input("Hi 👋");
    assert_eq!(input.cursor_position, 7);
    assert_eq!(input.input_buffer, "Hi 👋");
    press(&mut input, KeyCode::Left);
    assert_eq!(input.cursor_position, 3);
    press(&mut input, KeyCode::Right);
    assert_eq!(input.cursor_position, 7);
    press(&mut input, KeyCode::Left);
    press(&mut input, KeyCode::Char('!'));
    assert_eq!(input.input_buffer, "Hi !👋");
    assert_eq!(input.cursor_position, 4);
    press(&mut input, KeyCode::End);
    assert_eq!(input.cursor_position, 8);
    press(&mut input, KeyCode::Right);
    assert_eq!(input.cursor_position, 8);
}

#[test]
fn test_insert_and_delete() {
    let mut input = text_input("Hello");
    press(&mut input, KeyCode::Home);
    press(&mut input, KeyCode::Right);
    press(&mut input, KeyCode::Char('i'));
    assert_eq!(input.input_buffer, "Hiello");
    assert_eq!(input.cursor_position, 2);
    press(&mut input, KeyCode::Home);
    press(&mut input, KeyCode::Delete);
    assert_eq!(input.input_buffer, "iello");
    press(&mut input, KeyCode::End);
    press(&mut input, KeyCode::Delete);
    assert_eq!(input.input_buffer, "iello");
    press(&mut input, KeyCode::Home);
    press(&mut input, KeyCode::Backspace);
    assert_eq!(input.input_buffer, "iello");
    press(&mut input, KeyCode::End);
    press(&mut input, KeyCode::Left);
    press(&mut input, KeyCode::Backspace);
    assert_eq!(input.input_buffer, "ielo");
}

#[test]
fn test_empty_buffer() {
    let mut input = TextInput::new();
    for key in [KeyCode::Left, KeyCode::Right, KeyCode::Home, KeyCode::End] {
        press(&mut input, key);
        assert_eq!(input.cursor_position, 0);
    }
    for key in [KeyCode::Delete, KeyCode::Backspace] {
        press(&mut input, key);
        assert_eq!(input.input_buffer, "");
    }
}

#[test]
fn enter_is_delegated_without_mutating_the_draft() {
    let mut input = text_input("draft");

    assert!(!input.handle_input(&KeyEvent::new(KeyCode::Enter, KeyModifiers::empty())));
    assert_eq!(input.text(), "draft");
    assert_eq!(input.cursor_position, 5);
}

#[test]
fn test_word_movement() {
    let mut input = TextInput::new();
    input.set_text("The quick brown fox".to_string());
    assert_eq!(input.cursor_position, 19);
    for position in [16, 10, 4, 0, 0] {
        press_ctrl(&mut input, KeyCode::Left);
        assert_eq!(input.cursor_position, position);
    }
    for position in [4, 10, 16, 19, 19] {
        press_ctrl(&mut input, KeyCode::Right);
        assert_eq!(input.cursor_position, position);
    }
}

#[test]
fn test_utf8_word_movement() {
    let mut input = TextInput::new();
    input.set_text("Hello 👋 नमस्ते world 🌎".to_string());
    assert!(input.cursor_position > 0);
    for suffix in ["🌎", "world", "नमस्ते", "👋", "Hello"] {
        press_ctrl(&mut input, KeyCode::Left);
        assert!(input.text()[input.cursor_position..].starts_with(suffix));
    }
    assert_eq!(input.cursor_position, 0);
    press_ctrl(&mut input, KeyCode::Left);
    assert_eq!(input.cursor_position, 0);
    for prefix in ["Hello ", "👋 ", "नमस्ते ", "world ", "🌎"] {
        press_ctrl(&mut input, KeyCode::Right);
        assert!(input.text()[..input.cursor_position].ends_with(prefix));
    }
    assert_eq!(input.cursor_position, 40);
    press_ctrl(&mut input, KeyCode::Right);
    assert_eq!(input.cursor_position, 40);
}

#[test]
fn test_cursor_placement() {
    let mut input = text_input("Hello World");
    assert_eq!(input.cursor_position, 11);
    assert_eq!(input.cursor_offset(), 11);
    press(&mut input, KeyCode::Char('👋'));
    assert_eq!(input.cursor_position, 15);
    assert_eq!(input.cursor_offset(), 13);
}

#[test]
fn test_paste() {
    let mut input = text_input("Hello World");
    assert_eq!(input.cursor_position, 11);
    assert_eq!(input.cursor_offset(), 11);
    press(&mut input, KeyCode::Left);
    input.paste("👋");
    assert_eq!(input.cursor_position, 14);
    assert_eq!(input.cursor_offset(), 12);
    press(&mut input, KeyCode::End);
    input.paste("!");
    assert_eq!(input.text(), "Hello Worl👋d!")
}

#[test]
fn test_set_text() {
    let mut input = TextInput::new();
    input.set_text("Hello".to_string());
    assert_eq!(input.text(), "Hello");
    assert_eq!(input.cursor_position, 5);
}

#[test]
fn test_clear() {
    let mut input = TextInput::new();
    input.set_text("Hello".to_string());
    input.clear();
    assert_eq!(input.text(), "");
    assert_eq!(input.cursor_position, 0);
}
