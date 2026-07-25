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

#[test]
fn test_version_filtering() {
    let sample_changelog = r#"## [0.5.0]
Version 0.5.0 changes
## [0.4.0]
Version 0.4.0 changes
## [0.3.0]
Version 0.3.0 changes
"#;

    let filtered_sections = parse_changelog(
        sample_changelog,
        &Version::parse("0.4.0").unwrap(),
        &Version::parse("999.999.999").unwrap(),
    );

    assert_eq!(filtered_sections.len(), 1);
    assert_eq!(
        filtered_sections[0].version,
        Version::parse("0.5.0").unwrap()
    );

    let all_sections = parse_changelog(
        sample_changelog,
        &Version::parse("0.0.0").unwrap(),
        &Version::parse("999.999.999").unwrap(),
    );

    assert_eq!(all_sections.len(), 3);
}
