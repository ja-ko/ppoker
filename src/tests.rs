use super::*;
use temp_env::with_var;

use tempfile::TempDir;

#[test]
fn setup_logging_test() -> AppResult<()> {
    let temp_dir = TempDir::new()?;

    // Override log directory for testing
    with_var("HOME", Some(temp_dir.path().to_str().unwrap()), || {
        setup_logging().unwrap();

        info!("Info Logging");
        debug!("Debug Logging");

        let log_files: Vec<_> = glob(get_logdir().join("main-*.log").to_str().unwrap())
            .unwrap()
            .map(|f| f.unwrap())
            .collect();

        assert!(!log_files.is_empty(), "No log files were created");
        assert_eq!(log_files.len(), 1, "Expected exactly one log file");

        // Wait a moment for logs to be written
        std::thread::sleep(std::time::Duration::from_millis(100));
        tui_logger::move_events();

        // Read and check log content
        let log_content = std::fs::read_to_string(&log_files[0]).unwrap();
        assert!(
            log_content.contains("Info Logging"),
            "Info log message not found"
        );
        assert!(
            log_content.contains("Debug Logging"),
            "Debug log message not found"
        );
    });

    Ok(())
}
