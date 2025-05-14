use std::io::Stderr;
use std::path::PathBuf;
use std::{
    fs,
    io::{self},
};

use crate::app::{App, AppResult};
use crate::config::{get_config, get_logdir};
use crate::events::EventHandler;
use crate::tui::Tui;
use crate::update::{self_update, UpdateError, UpdateResult};
use filetime::FileTime;
use glob::glob;
use log::{debug, error, info, warn, LevelFilter};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use regex::Regex;
use tui_logger::TuiLoggerFile;

mod app;
mod config;
mod events;
mod models;
mod notification;
mod tui;
mod ui;
mod update;
mod web;

fn setup_logging() -> AppResult<()> {
    const MAX_LOGFILES: usize = 20;
    tui_logger::init_logger(LevelFilter::Debug).expect("Unable to setup logging capture");
    tui_logger::set_default_level(LevelFilter::Debug);
    
    let filename_regex = Regex::new(r"main-(?P<index>\d+)\.log")?;
    let log_dir = get_logdir();
    if !log_dir.exists() {
        fs::create_dir_all(&log_dir)?;
    }
    let mut existing_files: Vec<PathBuf> = glob(log_dir.join("main-*.log").to_str().unwrap())?
        .map(|f| f.unwrap())
        .collect();
    existing_files.sort_by_cached_key(|f| {
        let metadata = fs::metadata(f).unwrap();
        return FileTime::from_creation_time(&metadata);
    });

    let delete_files = existing_files.len().checked_sub(MAX_LOGFILES).unwrap_or(0);
    if delete_files > 0 {
        let drain = existing_files.drain(..delete_files);

        #[allow(unused_must_use)]
        for file in drain {
            debug!("Deleting old log file {:?}", file);
            fs::remove_file(file);
        }
    }

    let max_id = existing_files
        .iter()
        .map(|f| {
            let capture = filename_regex.captures(f.to_str().unwrap()).unwrap();
            capture["index"].parse::<i32>().unwrap()
        })
        .max()
        .unwrap_or(0);

    let log_file = log_dir.join(format!("main-{}.log", max_id + 1));
    tui_logger::set_log_file(TuiLoggerFile::new(log_file.as_os_str().to_str().unwrap()));
    info!("Logging to file {}", log_file.as_path().to_str().unwrap());

    Ok(())
}

fn run(app: &mut App, tui: &mut Tui<CrosstermBackend<Stderr>>) -> AppResult<()> {
    while app.running {
        tui.draw(app)?;
        tui.handle_events(app)?;
        app.update()?;
    }
    Ok(())
}

fn setup() -> AppResult<Option<(App, Tui<CrosstermBackend<Stderr>>)>> {
    setup_logging().unwrap_or_else(|err| error!("Failed to setup logging: {:?}", err));

    let config = get_config();

    if !config.skip_update_check {
        let res = self_update(&config);
        match res {
            Ok(UpdateResult::Updated) => {
                println!("Please restart the application.");
                return Ok(None);
            }
            Ok(UpdateResult::UpToDate) => {}
            Err(e) => {
                if matches!(e, UpdateError::NoCompatibleAssetFound)
                    || matches!(e, UpdateError::UserCanceled)
                {
                    warn!("Current release has no asset for current target.");
                } else {
                    error!("Failed to update the application. {}", e);
                    println!("Failed to update the application.");
                    return Err(e.into());
                }
            }
        }
    }

    let app = App::new(config)?;

    let backend = CrosstermBackend::new(io::stderr());
    let terminal = Terminal::new(backend)?;
    let events = EventHandler::new(250);
    let mut tui = Tui::new(terminal, events);
    tui.init()?;

    Ok(Some((app, tui)))
}

fn execute() -> AppResult<()> {
    if let Some((mut app, mut tui)) = setup()? {
        let result = run(&mut app, &mut tui);
        if let Err(e) = tui.exit() {
            error!("Failed to stop tui: {:?}", e)
        }
        result
    } else {
        Ok(())
    }
}

fn main() -> AppResult<()> {
    let result = execute();
    tui_logger::move_events();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::TempDir;

    #[test]
    fn setup_logging_test() -> AppResult<()> {
        let temp_dir = TempDir::new()?;
        let old_logdir = get_logdir();
        
        // Override log directory for testing
        std::env::set_var("HOME", temp_dir.path());

        setup_logging()?;
        
        info!("Info Logging");
        debug!("Debug Logging");

        let log_files: Vec<_> = glob(get_logdir().join("main-*.log").to_str().unwrap())?
            .map(|f| f.unwrap())
            .collect();

        assert!(!log_files.is_empty(), "No log files were created");
        assert_eq!(log_files.len(), 1, "Expected exactly one log file");

        // Wait a moment for logs to be written
        std::thread::sleep(std::time::Duration::from_millis(100));
        tui_logger::move_events();

        // Read and check log content
        let log_content = std::fs::read_to_string(&log_files[0])?;
        assert!(log_content.contains("Info Logging"), "Info log message not found");
        assert!(log_content.contains("Debug Logging"), "Debug log message not found");

        // Restore original log directory
        if let Some(old_path) = old_logdir.to_str() {
            std::env::set_var("HOME", old_path);
        }

        Ok(())
    }
}