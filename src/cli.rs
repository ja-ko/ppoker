use clap::Parser;

#[derive(Parser)]
#[command(version, about, long_about = None)]
pub struct Cli {

    /// Name to use for this session.
    #[arg(short, long)]
    pub(crate) name: Option<String>,

    /// Websocket URL to connect to.
    #[arg(short, long)]
    pub(crate) server: Option<String>,

    /// Room to join.
    #[arg()]
    pub(crate) room: Option<String>,
    
    /// Skip the automatic update check and stay on the current version.
    #[arg(short = 'S', long)]
    pub(crate) skip_update_check: bool,
}