use crossterm::{
    execute,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor},
};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use regex::Regex;
use std::io::{self, Write};

fn get_terminal_width() -> u16 {
    crossterm::terminal::size().map(|(w, _)| w).unwrap_or(80)
}

pub fn render_changelog(content: &str) -> io::Result<()> {
    let parser = Parser::new(content);
    let commit_regex = Regex::new(r"^[a-fA-F0-9]{7,40}$").unwrap();
    let mut stdout = io::stdout();

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                writeln!(stdout)?;
                if level == HeadingLevel::H2 {
                    execute!(
                        stdout,
                        SetForegroundColor(Color::Cyan),
                        SetAttribute(Attribute::Underlined),
                    )?;
                }
                execute!(stdout, SetAttribute(Attribute::Bold))?;
            }
            Event::End(TagEnd::Heading(_)) => {
                execute!(
                    stdout,
                    ResetColor,
                    SetAttribute(Attribute::NoBold),
                    SetAttribute(Attribute::NoUnderline),
                    Print("\n")
                )?;
            }
            Event::Start(Tag::Item) => {
                execute!(stdout, Print(" * "))?;
            }
            Event::End(TagEnd::Item) => {
                writeln!(stdout)?;
            }
            Event::Start(Tag::Strong) => {
                execute!(stdout, SetAttribute(Attribute::Bold))?;
            }
            Event::End(TagEnd::Strong) => {
                execute!(stdout, SetAttribute(Attribute::NoBold))?;
            }
            Event::Text(text) => {
                if commit_regex.is_match(&text) {
                    execute!(
                        stdout,
                        SetForegroundColor(Color::Yellow),
                        Print(text),
                        ResetColor
                    )?;
                } else {
                    execute!(stdout, Print(text))?;
                }
            }
            Event::Code(text) => {
                write!(stdout, "`{}`", text)?;
            }
            Event::HardBreak => {
                writeln!(stdout)?;
            }
            _ => {}
        }
    }

    writeln!(stdout)?;
    let width = get_terminal_width();
    execute!(
        stdout,
        SetAttribute(Attribute::Dim),
        Print("─".repeat(width.into())),
        ResetColor,
        Print("\n")
    )?;
    Ok(())
}

pub fn ask_to_show_changelog() -> io::Result<bool> {
    execute!(
        io::stdout(),
        Print("\nDo you want to see the changelog? [Y/n] ")
    )?;
    io::stdout().flush()?;

    let mut response = String::new();
    io::stdin().read_line(&mut response)?;
    let response = response.trim().to_lowercase();

    Ok(response.is_empty() || response == "y")
}
