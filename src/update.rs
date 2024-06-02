use std::error::Error;
use std::io;
use log::{debug, error, info};
use self_update::{cargo_crate_version, Extract, self_replace};
use semver::Version;
use snafu::Snafu;

#[derive(Debug, PartialEq)]
pub enum UpdateResult {
    UpToDate,
    Updated,
}

#[derive(Debug, Snafu)]
pub enum UpdateError {
    #[snafu(display("The user has canceled the update."))]
    UserCanceled,
    #[snafu(display("The current release does not contain a binary for this target."))]
    NoCompatibleAssetFound,
    #[snafu(display("An unknown error occured during the update: {error}"))]
    UpdateError{ error: self_update::errors::Error },
    #[snafu(display("An io error occured during the update: {error}"))]
    Io{ error: std::io::Error },
    #[snafu(display("Failed to parse semver: {error}"))]
    SemVer{ error: semver::Error },
}

impl From<self_update::errors::Error> for UpdateError {
    fn from(value: self_update::errors::Error) -> Self {
        UpdateError::UpdateError {error: value}
    }
}
impl From<std::io::Error> for UpdateError {
    fn from(value: std::io::Error) -> Self {
        UpdateError::Io {error: value}
    }
}

impl From<semver::Error> for UpdateError {
    fn from(value: semver::Error) -> Self {
        UpdateError::SemVer {error: value}
    }
}

pub fn self_update() -> Result<UpdateResult, UpdateError> {

    let update = self_update::backends::github::Update::configure()
        .repo_owner("ja-ko")
        .repo_name("ppoker")
        .bin_name("ppoker")
        .show_download_progress(true)
        .current_version(cargo_crate_version!())
        .show_output(false)
        .bin_path_in_archive("ppoker-{{ target }}/{{ bin }}")
        .build()?;

    debug!("Current binary: v{} - {}", update.current_version(), update.target());
    info!("Fetching update information.");
    let latest_release =  update.get_latest_release()?;

    if Version::parse(latest_release.version.as_str())? <= Version::parse(update.current_version().as_str())? {
        info!("Application is up-to-date.");
        return Ok(UpdateResult::UpToDate)
    }
    info!("Found newer release: v{}", latest_release.version);

    let asset = if let Some(asset) = latest_release.asset_for(update.target().as_str(), None) {
        asset
    } else {
        error!("Release {} did not contain asset for target {}", latest_release.name, update.target().as_str());
        return Err(UpdateError::NoCompatibleAssetFound.into());
    };

    println!("\nNew release found:");
    println!("  * Current release is: v{}", update.current_version());
    println!("  * Found release: {} v{}", asset.name, latest_release.version);
    println!("  * Download url: {}", asset.download_url);
    println!("\nThe new release will be downloaded and the existing binary will be replaced.");
    print!("\nDo you want to continue? [Y/n] ");
    ::std::io::Write::flush(&mut ::std::io::stdout())?;

    let mut s = String::new();
    io::stdin().read_line(&mut s)?;
    let s = s.trim().to_lowercase();
    if !s.is_empty() && s != "y" {
        info!("User aborted update.");
        return Err(UpdateError::UserCanceled.into());
    }

    let tmp_dir = tempfile::TempDir::new()?;
    let tmp_tarball_path = tmp_dir.path().join(&asset.name);
    let tmp_tarball = ::std::fs::File::create(&tmp_tarball_path)?;

    info!("Downloading release asset to {:?}.", tmp_tarball_path);

    self_update::Download::from_url(&asset.download_url)
        .set_header(reqwest::header::ACCEPT, "application/octet-stream".parse().unwrap())
        .show_progress(true)
        .download_to(&tmp_tarball)?;

    let path_in_archive = format!("ppoker-{}/{}", update.target(), update.bin_name());
    let filename = path_in_archive.as_str();
    info!("Extracting {} from archive.", filename);
    Extract::from_source(&tmp_tarball_path)
        .extract_file(tmp_dir.path(), filename)?;
    let binary = tmp_dir.path().join(filename);

    info!("Replacing binary file {:?} with {:?}", update.bin_install_path(), binary);
    self_replace::self_replace(binary)?;
    info!("Update to v{} done.", latest_release.version);

    Ok(UpdateResult::Updated)
}