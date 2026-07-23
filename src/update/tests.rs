use super::*;
use mockall::predicate;
use std::io::Cursor;

fn mock_update(current_version: &str, latest_version: &str) -> MockUpdateOperations {
    let target = self_update::get_target().to_owned();
    let latest_version = latest_version.to_owned();
    let mut update = MockUpdateOperations::new();
    update
        .expect_current_version()
        .return_const(current_version.to_owned());
    update.expect_target().return_const(target.clone());
    update
        .expect_bin_name()
        .return_const(GITHUB_REPO.to_owned());
    update
        .expect_bin_install_path()
        .returning(|| std::env::current_exe().unwrap());
    update.expect_get_latest_release().return_once(move || {
        Ok(Release {
            name: "Test release".to_owned(),
            version: latest_version,
            assets: vec![ReleaseAsset {
                download_url: "https://example.com/ppoker.tar.gz".to_owned(),
                name: format!("ppoker-{target}.tar.gz"),
            }],
            ..Release::default()
        })
    });
    update
}

#[test]
fn test_self_update() {
    let mut mock_config = Config::default();
    mock_config.keep_backup_on_update = true;

    let mut output = Vec::new();

    let mut mock_update = mock_update("0.0.1", "1.0.0");
    mock_update
        .expect_download_and_extract()
        .times(1)
        .returning(|_, tmp_dir, filename| {
            let binary = tmp_dir.join(filename);
            fs::create_dir_all(binary.parent().unwrap())?;
            fs::write(&binary, b"test binary")?;
            Ok(binary)
        });
    let mut mock_binary_ops = MockBinaryOperations::default();
    let mut mock_restarter = MockRestarter::new();
    let mut input = Cursor::new("y\n");
    let exe_path = std::env::current_exe().unwrap();

    mock_binary_ops
        .expect_backup_binary()
        .times(1)
        .returning(|_| Ok(()));

    mock_binary_ops
        .expect_self_replace()
        .times(1)
        .with(predicate::function(|p: &Path| {
            p.exists() && p.metadata().map(|m| m.len() > 0).unwrap_or(false)
        }))
        .returning(|_| Ok(()));

    // Expect restart to be called exactly once with the correct executable path
    mock_restarter
        .expect_restart()
        .times(1)
        .with(predicate::eq(exe_path))
        .returning(|_| ());

    let result = self_update_impl(
        &mock_config,
        &mut output,
        &mut input,
        &mock_update,
        &mock_binary_ops,
        &mock_restarter,
    );
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), UpdateResult::Updated);

    let output_str = String::from_utf8(output).unwrap();
    assert!(output_str.contains("Do you want to continue?"));
}

#[test]
fn test_self_update_up_to_date() {
    let mock_config = Config::default();
    let mut output = Vec::new();

    let mock_update = mock_update("999.0.0", "1.0.0");
    let mock_binary_ops = MockBinaryOperations::default();
    let mock_restarter = MockRestarter::new();
    let mut input = Cursor::new("");

    let result = self_update_impl(
        &mock_config,
        &mut output,
        &mut input,
        &mock_update,
        &mock_binary_ops,
        &mock_restarter,
    );

    assert_eq!(result.unwrap(), UpdateResult::UpToDate);

    let output_str = String::from_utf8(output).unwrap();
    assert!(output_str.is_empty());
}

#[test]
fn test_self_update_user_canceled() {
    let mock_config = Config::default();
    let mut output = Vec::new();

    let mock_update = mock_update("0.0.1", "1.0.0");
    let mut mock_binary_ops = MockBinaryOperations::default();
    mock_binary_ops
        .expect_self_replace()
        .times(0)
        .returning(|_| Ok(()));

    let mock_restarter = MockRestarter::new();
    let mut input = Cursor::new("n\n");

    let result = self_update_impl(
        &mock_config,
        &mut output,
        &mut input,
        &mock_update,
        &mock_binary_ops,
        &mock_restarter,
    );

    assert!(matches!(result, Err(UpdateError::UserCanceled)));

    let output_str = String::from_utf8(output).unwrap();
    assert!(output_str.contains("Do you want to continue?"));
}
