use super::*;
use std::fs::File;
use std::io::Write;
use temp_env::with_var;
use tempfile::TempDir;

#[test]
fn test_get_config_from_toml() {
    // Create temporary directory for test
    let temp_dir = TempDir::new().expect("Failed to create temp directory");

    // Set HOME to our temporary directory for this test
    with_var("HOME", Some(temp_dir.path().to_str().unwrap()), || {
        // Create config directory
        let config_dir = get_configdir();
        std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

        // Create config file
        let config_file = config_dir.join("config.toml");
        let mut file = File::create(&config_file).expect("Failed to create config file");

        // Write test configuration
        writeln!(file, "name = \"NebulaNomad\"").unwrap();
        writeln!(file, "server = \"wss://test.example.com/\"").unwrap();
        writeln!(file, "room = \"test-room\"").unwrap();
        writeln!(file, "skip_update_check = true").unwrap();
        file.flush().unwrap();

        // Get config
        let config = get_config();

        // Verify values are loaded from TOML
        assert_eq!(config.name, "NebulaNomad");
        assert_eq!(config.server, "wss://test.example.com/");
        assert_eq!(config.room, "test-room");
        assert!(config.skip_update_check);
        assert!(!config.disable_notifications); // Default value not overridden
    });
}

#[test]
fn test_env_vars_override_toml() {
    // Create temporary directory for test
    let temp_dir = TempDir::new().expect("Failed to create temp directory");

    // Set HOME and env vars for the test
    with_var("HOME", Some(temp_dir.path().to_str().unwrap()), || {
        with_var("PPOKER_NAME", Some("EnvUser"), || {
            with_var("PPOKER_SERVER", Some("wss://env.example.com/"), || {
                // Create config directory and file
                let config_dir = get_configdir();
                std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");
                let config_file = config_dir.join("config.toml");
                let mut file = File::create(&config_file).expect("Failed to create config file");

                // Write TOML configuration
                writeln!(file, "name = \"TomlUser\"").unwrap();
                writeln!(file, "server = \"wss://toml.example.com/\"").unwrap();
                file.flush().unwrap();

                // Get config
                let config = get_config();

                // Verify env vars override TOML
                assert_eq!(config.name, "EnvUser");
                assert_eq!(config.server, "wss://env.example.com/");
            });
        });
    });
}
