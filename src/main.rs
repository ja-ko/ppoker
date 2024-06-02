use std::{fs, io};
use std::path::PathBuf;
use clap::Parser;
use filetime::FileTime;
use glob::glob;
use log::{debug, error, info, LevelFilter};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use regex::Regex;
use self_update::{cargo_crate_version, Status};
use crate::app::{App, AppResult};
use crate::cli::Cli;
use crate::config::{get_config, get_logdir};
use crate::events::EventHandler;
use crate::tui::Tui;

mod app;
mod tui;
mod ui;
mod events;
mod models;
mod cli;
mod config;
mod web;

fn setup_logging() -> AppResult<()> {
    const MAX_LOGFILES: usize = 20;
    let filename_regex = Regex::new(r"main-(?P<index>\d+)\.log")?;
    let log_dir = get_logdir();
    if !log_dir.exists() {
        fs::create_dir_all(&log_dir)?;
    }
    let mut existing_files: Vec<PathBuf> = glob(log_dir.join("main-*.log").to_str().unwrap())?
        .map(|f| f.unwrap()).collect();
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

    let max_id = existing_files.iter().map(|f| {
        let capture = filename_regex.captures(f.to_str().unwrap()).unwrap();
        capture["index"].parse::<i32>().unwrap()
    }).max().unwrap_or(0);


    let log_file = log_dir.join(format!("main-{}.log", max_id + 1));
    tui_logger::set_log_file(log_file.as_os_str().to_str().unwrap())?;
    info!("Logging to file {}", log_file.as_path().to_str().unwrap());

    Ok(())
}

fn main() -> AppResult<()> {
    tui_logger::init_logger(LevelFilter::Debug).expect("Unable to setup logging capture");
    tui_logger::set_default_level(LevelFilter::Debug);

    setup_logging().unwrap_or_else(|err| error!("Failed to setup logging: {:?}", err));

    let cli = Cli::parse();
    let mut config = get_config();
    if let Some(name) = cli.name {
        config.name = name;
    }
    if let Some(room) = cli.room {
        config.room = room;
    }
    if let Some(server) = cli.server {
        config.server = server;
    }
    if cli.skip_update_check {
        config.skip_update_check = true;
    }

    let update = update()?;
    match update {
        Status::UpToDate(version) => { info!("Already up-to-date: {}", version) }
        Status::Updated(version) => {
            println!("Updated: {}", version);
            return Ok(());
        }
    }

    let mut app = App::new(config)?;

    let backend = CrosstermBackend::new(io::stderr());
    let terminal = Terminal::new(backend)?;
    let events = EventHandler::new(250);
    let mut tui = Tui::new(terminal, events);
    tui.init()?;

    while app.running {
        tui.draw(&mut app)?;
        tui.handle_events(&mut app)?;
        app.update()?;
    }

    tui.exit()?;
    Ok(())
}

pub fn update() -> self_update::errors::Result<Status> {
    let update = self_update::backends::github::Update::configure()
        .repo_owner("ja-ko")
        .repo_name("ppoker")
        .bin_name("ppoker")
        .show_download_progress(true)
        .current_version(cargo_crate_version!())
        .show_output(false)
        .bin_path_in_archive("ppoker-{{ target }}/{{ bin }}")
        .build()?;
    
    update.update()
}


