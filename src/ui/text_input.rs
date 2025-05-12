use crossterm::event::{KeyCode, KeyEvent};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::prelude::Widget;
use ratatui::widgets::Paragraph;

pub struct TextInput {
    input_buffer: String,
    cursor_position: usize,
}

impl TextInput {
    pub fn new() -> Self {
        Self {
            input_buffer: String::new(),
            cursor_position: 0,
        }
    }

    pub fn handle_input(&mut self, event: &KeyEvent) -> bool {
        match event.code {
            KeyCode::Backspace => {
                if self.cursor_position > 0 {
                    let new_pos = self.input_buffer[..self.cursor_position]
                        .char_indices()
                        .next_back()
                        .map_or(0, |(i, _)| i);

                    self.input_buffer.remove(new_pos);
                    self.cursor_position = new_pos;
                }
                true
            }
            KeyCode::Delete => {
                if self.cursor_position < self.input_buffer.len() {
                    self.input_buffer.remove(self.cursor_position);
                }
                true
            }
            KeyCode::Left => {
                if self.cursor_position > 0 {
                    let new_pos = self.input_buffer[..self.cursor_position]
                        .char_indices()
                        .next_back()
                        .map_or(0, |(i, _)| i);
                    self.cursor_position = new_pos;
                }
                true
            }
            KeyCode::Right => {
                if self.cursor_position < self.input_buffer.len() {
                    let next_char_boundary = self.input_buffer[self.cursor_position..]
                        .chars()
                        .next()
                        .map(|c| self.cursor_position + c.len_utf8());
                    if let Some(pos) = next_char_boundary {
                        self.cursor_position = pos;
                    }
                }
                true
            }
            KeyCode::Home => {
                self.cursor_position = 0;
                true
            }
            KeyCode::End => {
                self.cursor_position = self.input_buffer.len();
                true
            }
            KeyCode::Char(c) => {
                self.input_buffer.insert(self.cursor_position, c);
                self.cursor_position += c.len_utf8();
                true
            }
            _ => false,
        }
    }
    
    pub fn paste(&mut self, text: &str) {
        self.input_buffer.insert_str(self.cursor_position, &text);
        self.cursor_position += text.chars().map(|c| c.len_utf8()).sum::<usize>();
    }

    pub fn text(&self) -> &str {
        self.input_buffer.as_str()
    }

    pub fn set_text(&mut self, text: String) {
        self.input_buffer = text;
        self.cursor_position = self.input_buffer.len();
    }

    pub fn clear(&mut self) {
        self.input_buffer.clear();
        self.cursor_position = 0;
    }

    // This should be used to render the cursor for this text input since it respects utf8 character
    // widths.
    pub fn cursor_offset(&self) -> u16 {
        let cursor_text = self.input_buffer[..self.cursor_position].to_string();
        let cursor_paragraph = Paragraph::new(cursor_text);

        cursor_paragraph.line_width() as u16
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        let paragraph = Paragraph::new(self.input_buffer.clone());
        paragraph.render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn make_key_event(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::empty())
    }

    #[test]
    fn test_basic_input() {
        let mut input = TextInput::new();

        // Type text character by character
        input.handle_input(&make_key_event(KeyCode::Char('H')));
        assert_eq!(input.input_buffer, "H");
        assert_eq!(input.cursor_position, 1);

        input.handle_input(&make_key_event(KeyCode::Char('e')));
        input.handle_input(&make_key_event(KeyCode::Char('l')));
        input.handle_input(&make_key_event(KeyCode::Char('l')));
        input.handle_input(&make_key_event(KeyCode::Char('o')));

        assert_eq!(input.input_buffer, "Hello");
        assert_eq!(input.cursor_position, 5);
    }

    #[test]
    fn test_cursor_movement() {
        let mut input = TextInput::new();

        // Build up text with key events
        for c in "Hello World".chars() {
            input.handle_input(&make_key_event(KeyCode::Char(c)));
        }
        assert_eq!(input.cursor_position, 11);

        // Test left arrow
        input.handle_input(&make_key_event(KeyCode::Left));
        assert_eq!(input.cursor_position, 10);
        input.handle_input(&make_key_event(KeyCode::Left));
        assert_eq!(input.cursor_position, 9);

        // Test right arrow
        input.handle_input(&make_key_event(KeyCode::Right));
        assert_eq!(input.cursor_position, 10);
        input.handle_input(&make_key_event(KeyCode::Right));
        assert_eq!(input.cursor_position, 11);

        // Test boundary conditions
        for _ in 0..15 {
            input.handle_input(&make_key_event(KeyCode::Left));
        }
        assert_eq!(
            input.cursor_position, 0,
            "Cursor should stop at left boundary"
        );

        for _ in 0..15 {
            input.handle_input(&make_key_event(KeyCode::Right));
        }
        assert_eq!(
            input.cursor_position, 11,
            "Cursor should stop at right boundary"
        );

        // Test Home/End
        input.handle_input(&make_key_event(KeyCode::Home));
        assert_eq!(input.cursor_position, 0);
        input.handle_input(&make_key_event(KeyCode::End));
        assert_eq!(input.cursor_position, 11);
    }

    #[test]
    fn test_utf8_navigation() {
        let mut input = TextInput::new();

        for c in "Hi 👋".chars() {
            input.handle_input(&make_key_event(KeyCode::Char(c)));
        }

        // Cursor should be at the end (after emoji)
        assert_eq!(input.cursor_position, 7); // "Hi " is 3 bytes, 👋 is 4 bytes
        assert_eq!(input.input_buffer, "Hi 👋");

        // Move cursor left (should jump over entire emoji)
        input.handle_input(&make_key_event(KeyCode::Left));
        assert_eq!(input.cursor_position, 3); // Before emoji

        // Move cursor right (should jump over entire emoji)
        input.handle_input(&make_key_event(KeyCode::Right));
        assert_eq!(input.cursor_position, 7); // After emoji

        // Insert ASCII character before emoji
        input.handle_input(&make_key_event(KeyCode::Left));
        input.handle_input(&make_key_event(KeyCode::Char('!')));
        assert_eq!(input.input_buffer, "Hi !👋");
        assert_eq!(input.cursor_position, 4);

        // Boundary check should still work with UTF-8 characters
        input.handle_input(&make_key_event(KeyCode::End));
        assert_eq!(input.cursor_position, 8);
        input.handle_input(&make_key_event(KeyCode::Right));
        assert_eq!(input.cursor_position, 8);
    }

    #[test]
    fn test_insert_and_delete() {
        let mut input = TextInput::new();

        // Build initial text with key events
        for c in "Hello".chars() {
            input.handle_input(&make_key_event(KeyCode::Char(c)));
        }

        // Insert in the middle
        input.handle_input(&make_key_event(KeyCode::Home));
        input.handle_input(&make_key_event(KeyCode::Right));
        input.handle_input(&make_key_event(KeyCode::Char('i')));
        assert_eq!(input.input_buffer, "Hiello");
        assert_eq!(input.cursor_position, 2);

        // Delete at the start
        input.handle_input(&make_key_event(KeyCode::Home));
        input.handle_input(&make_key_event(KeyCode::Delete));
        assert_eq!(input.input_buffer, "iello");

        // Delete at the end should do nothing
        input.handle_input(&make_key_event(KeyCode::End));
        input.handle_input(&make_key_event(KeyCode::Delete));
        assert_eq!(input.input_buffer, "iello");

        // Backspace at the start should do nothing
        input.handle_input(&make_key_event(KeyCode::Home));
        input.handle_input(&make_key_event(KeyCode::Backspace));
        assert_eq!(input.input_buffer, "iello");

        // Backspace in the middle
        input.handle_input(&make_key_event(KeyCode::End));
        input.handle_input(&make_key_event(KeyCode::Left));
        input.handle_input(&make_key_event(KeyCode::Backspace));
        assert_eq!(input.input_buffer, "ielo");
    }

    #[test]
    fn test_empty_buffer() {
        let mut input = TextInput::new();

        // Try navigating in empty buffer
        input.handle_input(&make_key_event(KeyCode::Left));
        assert_eq!(input.cursor_position, 0);
        input.handle_input(&make_key_event(KeyCode::Right));
        assert_eq!(input.cursor_position, 0);
        input.handle_input(&make_key_event(KeyCode::Home));
        assert_eq!(input.cursor_position, 0);
        input.handle_input(&make_key_event(KeyCode::End));
        assert_eq!(input.cursor_position, 0);

        // Try deleting from an empty buffer
        input.handle_input(&make_key_event(KeyCode::Delete));
        assert_eq!(input.input_buffer, "");
        input.handle_input(&make_key_event(KeyCode::Backspace));
        assert_eq!(input.input_buffer, "");
    }


    #[test]
    fn test_cursor_placement() {
        let mut input = TextInput::new();

        // Build up text with key events
        for c in "Hello World".chars() {
            input.handle_input(&make_key_event(KeyCode::Char(c)));
        }
        assert_eq!(input.cursor_position, 11);
        assert_eq!(input.cursor_offset(), 11);

        input.handle_input(&make_key_event(KeyCode::Char('👋')));
        assert_eq!(input.cursor_position, 15);
        assert_eq!(input.cursor_offset(), 13);
    }

    #[test]
    fn test_paste() {
        let mut input = TextInput::new();

        // Build up text with key events
        for c in "Hello World".chars() {
            input.handle_input(&make_key_event(KeyCode::Char(c)));
        }
        assert_eq!(input.cursor_position, 11);
        assert_eq!(input.cursor_offset(), 11);

        input.handle_input(&make_key_event(KeyCode::Left));
        input.paste("👋");
        assert_eq!(input.cursor_position, 14);
        assert_eq!(input.cursor_offset(), 12);

        input.handle_input(&make_key_event(KeyCode::End));

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
}