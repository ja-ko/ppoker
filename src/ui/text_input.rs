use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
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

    fn find_prev_word_boundary(&self, from: usize) -> usize {
        let text = &self.input_buffer[..from];
        let mut in_word = false;
        for (i, c) in text.char_indices().rev() {
            if c.is_whitespace() {
                if in_word {
                    return i + 1;
                }
            } else {
                in_word = true;
            }
        }
        0
    }

    fn find_next_word_boundary(&self, from: usize) -> usize {
        let text = &self.input_buffer[from..];
        let mut seen_space = false;
        for (i, c) in text.char_indices() {
            if c.is_whitespace() {
                seen_space = true;
            } else if seen_space {
                return from + i;
            }
        }
        self.input_buffer.len()
    }

    pub fn handle_input(&mut self, event: &KeyEvent) -> bool {
        match event.code {
            KeyCode::Left if event.modifiers.contains(KeyModifiers::CONTROL) => {
                self.cursor_position = self.find_prev_word_boundary(self.cursor_position);
                true
            }
            KeyCode::Right if event.modifiers.contains(KeyModifiers::CONTROL) => {
                self.cursor_position = self.find_next_word_boundary(self.cursor_position);
                true
            }
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
        self.input_buffer.insert_str(self.cursor_position, text);
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
mod tests;
