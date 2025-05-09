use regex::Regex;
use reqwest::blocking::Client;
use semver::Version;

#[derive(Debug, PartialEq)]
pub struct ChangelogSection {
    pub version: Version,
    pub content: String,
}

pub fn fetch_changelog(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(Client::new().get(url).send()?.text()?)
}

/// Parse changelog content into sections, returning only versions between current_version (exclusive) and target_version (inclusive)
///
/// # Arguments
/// * `content` - The changelog content to parse
/// * `current_version` - The current version
/// * `target_version` - The target version
///
/// # Returns
/// A vector of changelog sections for versions between current_version and target_version
pub fn parse_changelog(
    content: &str,
    current_version: &Version,
    target_version: &Version,
) -> Vec<ChangelogSection> {
    if current_version >= target_version {
        return vec![];
    }

    let version_re = Regex::new(r"##\s+\[([0-9.]+)]").unwrap();
    let mut sections = Vec::new();
    let mut current_version_str = String::new();
    let mut current_section = String::new();

    for line in content.lines() {
        if let Some(cap) = version_re.captures(line) {
            // When we find a new version header, save the previous section if valid and in range
            section_completed(
                current_version,
                target_version,
                &mut sections,
                &mut current_version_str,
                current_section,
            );
            // Start a new section
            current_version_str = cap[1].to_string();
            current_section = String::from(line) + "\n";
        } else if !current_version_str.is_empty() {
            current_section.push_str(line);
            current_section.push('\n');
        }
    }

    // Handle the last section
    section_completed(
        current_version,
        target_version,
        &mut sections,
        &mut current_version_str,
        current_section,
    );

    sections
}

fn section_completed(
    current_version: &Version,
    target_version: &Version,
    sections: &mut Vec<ChangelogSection>,
    current_version_str: &mut String,
    current_section: String,
) {
    if !current_section.is_empty() && !current_version_str.is_empty() {
        if let Ok(version) = Version::parse(&current_version_str) {
            if version > *current_version && version <= *target_version {
                sections.push(ChangelogSection {
                    version,
                    content: current_section,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_empty_changelog() {
        let current = Version::parse("1.0.0").unwrap();
        let target = Version::parse("2.0.0").unwrap();
        assert!(parse_changelog("", &current, &target).is_empty());
    }

    #[test]
    fn test_parse_version_in_range() {
        let content = r#"## [1.2.0]
Some changes here
More changes
"#;
        let current = Version::parse("1.1.0").unwrap();
        let target = Version::parse("1.2.0").unwrap();
        let sections = parse_changelog(content, &current, &target);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
        assert_eq!(
            sections[0].content,
            "## [1.2.0]\nSome changes here\nMore changes\n"
        );
    }

    #[test]
    fn test_parse_multiple_versions_filtering() {
        let content = r#"## [1.3.0]
Version 1.3.0 changes
## [1.2.0]
Version 1.2.0 changes
## [1.1.0]
Version 1.1.0 changes
## [1.0.0]
Version 1.0.0 changes
"#;
        let current = Version::parse("1.1.0").unwrap();
        let target = Version::parse("1.2.0").unwrap();
        let sections = parse_changelog(content, &current, &target);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
    }

    #[test]
    fn test_ignore_versions_outside_range() {
        let content = r#"## [2.0.0]
Future version
## [1.2.0]
Current target
## [1.0.0]
Old version
"#;
        let current = Version::parse("1.1.0").unwrap();
        let target = Version::parse("1.2.0").unwrap();
        let sections = parse_changelog(content, &current, &target);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].version, Version::parse("1.2.0").unwrap());
    }

    #[test]
    fn test_preserve_section_formatting() {
        let content = r#"## [1.2.0]
### Features
- Feature 1
- Feature 2

### Bug Fixes
- Fix 1
"#;
        let current = Version::parse("1.1.0").unwrap();
        let target = Version::parse("1.2.0").unwrap();
        let sections = parse_changelog(content, &current, &target);
        assert_eq!(sections[0].content, content);
    }
}
