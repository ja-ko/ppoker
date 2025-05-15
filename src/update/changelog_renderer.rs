use crossterm::{
    execute,
    style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor},
};
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use regex::Regex;
use std::io::{self, Write};

fn get_terminal_width() -> u16 {
    #[cfg(test)]
    {
        return 80;
    }
    #[cfg(not(test))]
    {
        crossterm::terminal::size().map(|(w, _)| w).unwrap_or(80)
    }

}

pub fn render_changelog<W: Write>(content: &str, writer: &mut W) -> io::Result<()> {
    let parser = Parser::new(content);
    let commit_regex = Regex::new(r"^[a-fA-F0-9]{7,40}$").unwrap();
    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                writeln!(writer)?;
                if level == HeadingLevel::H2 {
                    execute!(
                        writer,
                        SetForegroundColor(Color::Cyan),
                        SetAttribute(Attribute::Underlined),
                    )?;
                }
                execute!(writer, SetAttribute(Attribute::Bold))?;
            }
            Event::End(TagEnd::Heading(_)) => {
                execute!(
                    writer,
                    ResetColor,
                    SetAttribute(Attribute::NormalIntensity),
                    SetAttribute(Attribute::NoUnderline),
                    Print("\n")
                )?;
            }
            Event::Start(Tag::Item) => {
                execute!(writer, Print(" * "))?;
            }
            Event::End(TagEnd::Item) => {
                writeln!(writer)?;
            }
            Event::Start(Tag::Strong) => {
                execute!(writer, SetAttribute(Attribute::Bold))?;
            }
            Event::End(TagEnd::Strong) => {
                execute!(writer, SetAttribute(Attribute::NormalIntensity))?;
            }
            Event::Text(text) => {
                if commit_regex.is_match(&text) {
                    execute!(
                        writer,
                        SetForegroundColor(Color::Yellow),
                        Print(text),
                        ResetColor
                    )?;
                } else {
                    execute!(writer, Print(text))?;
                }
            }
            Event::Code(text) => {
                write!(writer, "`{}`", text)?;
            }
            Event::HardBreak => {
                writeln!(writer)?;
            }
            _ => {}
        }
    }

    writeln!(writer)?;
    let width = get_terminal_width();
    execute!(
        writer,
        SetAttribute(Attribute::Dim),
        Print("─".repeat(width.into())),
        ResetColor,
        Print("\n")
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    struct TestWriter {
        content: String,
    }

    impl TestWriter {
        fn new() -> Self {
            Self {
                content: String::new(),
            }
        }
    }

    impl Write for TestWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.content.push_str(std::str::from_utf8(buf).unwrap());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn test_render_basic_markdown() -> io::Result<()> {
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

        let mut writer = TestWriter::new();
        render_changelog(markdown, &mut writer)?;

        const CYAN: &str = "\x1b[38;5;14m";
        const YELLOW: &str = "\x1b[38;5;11m";
        const DIM: &str = "\x1b[2m";
        const BOLD_START: &str = "\x1b[1m";
        const BOLD_END: &str = "\x1b[22m";
        const UNDERLINE_START: &str = "\x1b[4m";
        const UNDERLINE_END: &str = "\x1b[24m";
        const RESET: &str = "\x1b[0m";

        assert_eq!(writer.content, format!(r#"
{CYAN}{UNDERLINE_START}{BOLD_START}0.5.0 (2025-05-11){RESET}{BOLD_END}{UNDERLINE_END}

{BOLD_START}Features{RESET}{BOLD_END}{UNDERLINE_END}
 * {BOLD_START}ui:{BOLD_END} add cursor navigation and editing support in text input ({YELLOW}4c823a3{RESET}), closes #61
 * {BOLD_START}ui:{BOLD_END} sanitize input strings across voting UI ({YELLOW}9acb561{RESET}), closes #59
 * {BOLD_START}update:{BOLD_END} add binary backup support during updates ({YELLOW}3069818{RESET})
 * {BOLD_START}update:{BOLD_END} add changelog parsing and display for updates ({YELLOW}03a1cab{RESET})
 * {BOLD_START}update:{BOLD_END} add rich terminal rendering for changelog display ({YELLOW}2018401{RESET})

{BOLD_START}Bug Fixes{RESET}{BOLD_END}{UNDERLINE_END}
 * cursor not moving right on right press. ({YELLOW}6247234{RESET})
 * {BOLD_START}ui:{BOLD_END} correct cursor position in input box rendering ({YELLOW}48be407{RESET}), closes #60
 * {BOLD_START}ui:{BOLD_END} fix a crash that occurred when navigating right through multibyte character ({YELLOW}094114d{RESET})

{DIM}{}{RESET}
"#, "─".repeat(80)));


        Ok(())
    }

}

