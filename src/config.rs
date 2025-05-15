use std::fs;
use std::path::PathBuf;

use clap::Parser;
use directories::ProjectDirs;
use figment::providers::{Env, Format, Serialized, Toml};
use figment::Figment;
use log::{error, info};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Parser)]
#[command(version, about, long_about = None)]
pub struct Cli {
    /// Name to use for this session.
    #[arg(short, long)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,

    /// Websocket URL to connect to.
    #[arg(short, long)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server: Option<String>,

    /// Room to join.
    #[arg()]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) room: Option<String>,

    /// Disables automatic reveal of cards
    #[arg(short = 'A', long)]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) disable_auto_reveal: bool,

    /// Skip the automatic update check and stay on the current version.
    #[arg(short = 'S', long)]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) skip_update_check: bool,

    /// Disable notifications
    #[arg(short = 'N', long)]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) disable_notifications: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub name: String,
    pub room: String,
    pub server: String,
    pub skip_update_check: bool,
    pub disable_notifications: bool,
    pub disable_auto_reveal: bool,
    pub keep_backup_on_update: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            name: whoami::username(),
            room: petname::petname(3, "").expect("Failed to generate random room name"),
            server: "wss://pp.discordia.network/".to_owned(),
            skip_update_check: false,
            disable_notifications: false,
            disable_auto_reveal: false,
            keep_backup_on_update: true,
        }
    }
}

fn create_projdirs() -> ProjectDirs {
    return ProjectDirs::from("dev.jko", "", "ppoker").expect("Failed to get OS directories");
}

pub fn get_configdir() -> PathBuf {
    let dirs = create_projdirs();
    let dir = dirs.config_dir();
    if !dir.exists() {
        fs::create_dir_all(dir).expect("Failed to create config directory");
    }
    return dir.to_owned();
}

pub fn get_logdir() -> PathBuf {
    let dir = create_projdirs().data_dir().join("logs");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Failed to create log directory");
    }
    return dir.to_owned();
}

pub fn get_config() -> Config {
    let config_file = get_configdir().join("config.toml");
    info!(
        "Trying to load config from {}",
        config_file.to_string_lossy()
    );
    let figment = Figment::from(Serialized::defaults(Config::default()))
        .merge(Toml::file(config_file.as_path()))
        .merge(Env::prefixed("PPOKER_"))
        .merge(Serialized::defaults(Cli::parse()));

    let result = figment.extract();
    return result.unwrap_or_else(|e| {
        error!("Failed to load config: {}", e);
        Config::default()
    });
}

#[cfg(test)]
mod tests {
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
            assert_eq!(config.skip_update_check, true);
            assert_eq!(config.disable_notifications, false); // Default value not overridden
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
}
