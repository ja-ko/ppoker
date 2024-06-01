use std::fs;
use std::path::PathBuf;
use directories::ProjectDirs;
use figment::Figment;
use figment::providers::{Env, Format, Serialized, Toml};
use log::{error, info};
use serde::{Deserialize, Serialize};

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

pub fn get_logdir()  -> PathBuf {
    let dir = create_projdirs().data_dir().join("logs");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Failed to create log directory");
    }
    return dir.to_owned();
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub name: String,
    pub room: String,
    pub server: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            name: whoami::username(),
            room: petname::petname(3, "").expect("Failed to generate random room name"),
            server: "wss://pp.discordia.network/".to_owned(),
        }
    }
}

pub fn get_config() -> Config {
    let config_file = get_configdir().join("config.toml");
    info!("Trying to load config from {}", config_file.to_string_lossy());
    let figment = Figment::from(Serialized::defaults(Config::default()))
        .merge(Toml::file(config_file.as_path()))
        .merge(Env::prefixed("PPOKER_"));

    let result = figment.extract();
    return result.unwrap_or_else(|e| {
        error!("Failed to load config: {}", e);
        Config::default()
    })
}