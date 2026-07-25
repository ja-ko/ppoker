use std::fs;
use std::io::{stdin, stdout, BufReader};
use std::path::{Path, PathBuf};
use std::process;

use crate::config::Config;
use log::{debug, error, info};
use self_update::update::{Release, ReleaseAsset, ReleaseUpdate};
use self_update::{cargo_crate_version, Extract};
use semver::Version;
use snafu::Snafu;

#[cfg(test)]
use mockall::{automock, predicate::*};
use self_update::self_replace::self_replace;
use subprocess::Exec;

const GITHUB_OWNER: &str = "ja-ko";
const GITHUB_REPO: &str = "ppoker";
const BIN_PATH_TEMPLATE: &str = "ppoker-{{ target }}/{{ bin }}";

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
    Backend { error: self_update::errors::Error },
    #[snafu(display("An io error occured during the update: {error}"))]
    Io { error: std::io::Error },
    #[snafu(display("Failed to parse semver: {error}"))]
    SemVer { error: semver::Error },
}

impl From<self_update::errors::Error> for UpdateError {
    fn from(value: self_update::errors::Error) -> Self {
        UpdateError::Backend { error: value }
    }
}
impl From<std::io::Error> for UpdateError {
    fn from(value: std::io::Error) -> Self {
        UpdateError::Io { error: value }
    }
}

impl From<semver::Error> for UpdateError {
    fn from(value: semver::Error) -> Self {
        UpdateError::SemVer { error: value }
    }
}

#[cfg_attr(test, automock)]
trait BinaryOperations {
    fn self_replace(&self, binary: &Path) -> Result<(), self_update::errors::Error>;
    fn backup_binary(&self, path: &Path) -> Result<(), UpdateError>;
}

struct DefaultBinaryOperations;

impl Default for DefaultBinaryOperations {
    fn default() -> Self {
        Self
    }
}

impl BinaryOperations for DefaultBinaryOperations {
    fn self_replace(&self, binary: &Path) -> Result<(), self_update::errors::Error> {
        Ok(self_replace(binary)?)
    }

    fn backup_binary(&self, path: &Path) -> Result<(), UpdateError> {
        let backup_path = path.with_extension("bak");
        if backup_path.exists() {
            fs::remove_file(&backup_path)?;
        }
        fs::copy(path, &backup_path)?;
        Ok(())
    }
}

#[cfg_attr(test, automock)]
trait UpdateOperations {
    fn current_version(&self) -> String;
    fn target(&self) -> String;
    fn bin_name(&self) -> String;
    fn bin_install_path(&self) -> PathBuf;
    fn get_latest_release(&self) -> Result<Release, self_update::errors::Error>;
    fn download_and_extract(
        &self,
        asset: &ReleaseAsset,
        tmp_dir: &Path,
        filename: &str,
    ) -> Result<PathBuf, UpdateError>;
}

struct DefaultUpdateOperations {
    update: Box<dyn ReleaseUpdate>,
}

impl DefaultUpdateOperations {
    fn new(current_version: &str) -> Result<Self, self_update::errors::Error> {
        let update = self_update::backends::github::Update::configure()
            .repo_owner(GITHUB_OWNER)
            .repo_name(GITHUB_REPO)
            .bin_name(GITHUB_REPO)
            .show_download_progress(true)
            .current_version(current_version)
            .show_output(false)
            .bin_path_in_archive(BIN_PATH_TEMPLATE)
            .build()?;
        Ok(Self { update })
    }
}

impl UpdateOperations for DefaultUpdateOperations {
    fn current_version(&self) -> String {
        self.update.current_version()
    }

    fn target(&self) -> String {
        self.update.target()
    }

    fn bin_name(&self) -> String {
        self.update.bin_name()
    }

    fn bin_install_path(&self) -> PathBuf {
        self.update.bin_install_path()
    }

    fn get_latest_release(&self) -> Result<Release, self_update::errors::Error> {
        self.update.get_latest_release()
    }

    fn download_and_extract(
        &self,
        asset: &ReleaseAsset,
        tmp_dir: &Path,
        filename: &str,
    ) -> Result<PathBuf, UpdateError> {
        let tmp_tarball_path = tmp_dir.join(&asset.name);
        let tmp_tarball = fs::File::create(&tmp_tarball_path)?;

        info!("Downloading release asset to {:?}.", tmp_tarball_path);
        self_update::Download::from_url(&asset.download_url)
            .set_header(
                reqwest::header::ACCEPT,
                "application/octet-stream".parse().unwrap(),
            )
            .show_progress(true)
            .download_to(&tmp_tarball)?;

        info!("Extracting {} from archive.", filename);
        Extract::from_source(&tmp_tarball_path).extract_file(tmp_dir, filename)?;
        Ok(tmp_dir.join(filename))
    }
}

#[cfg_attr(test, automock)]
pub trait Restarter {
    fn restart(&self, exe_path: &Path);
}

struct DefaultRestarter;

impl Default for DefaultRestarter {
    fn default() -> Self {
        Self
    }
}

impl Restarter for DefaultRestarter {
    fn restart(&self, exe_path: &Path) {
        println!("{}", exe_path.to_str().unwrap());
        Exec::cmd(exe_path)
            .arg("--changelog-from")
            .arg(cargo_crate_version!())
            .detached()
            .start()
            .expect("Failed to start new binary");
        info!("Successfully executed updated binary, exiting.");
        process::exit(0);
    }
}

pub fn self_update(config: &Config) -> Result<UpdateResult, UpdateError> {
    let update = DefaultUpdateOperations::new(cargo_crate_version!())?;
    self_update_impl(
        config,
        &mut stdout(),
        &mut BufReader::new(stdin()),
        &update,
        &DefaultBinaryOperations,
        &DefaultRestarter,
    )
}

fn self_update_impl<W: std::io::Write, R: std::io::BufRead>(
    config: &Config,
    stdout: &mut W,
    stdin: &mut R,
    update: &impl UpdateOperations,
    binary_ops: &impl BinaryOperations,
    restarter: &impl Restarter,
) -> Result<UpdateResult, UpdateError> {
    let exe_path = std::env::current_exe()?;

    debug!(
        "Current binary: v{} - {}",
        update.current_version(),
        update.target()
    );
    info!("Fetching update information.");
    let latest_release = update.get_latest_release()?;

    if Version::parse(latest_release.version.as_str())?
        <= Version::parse(update.current_version().as_str())?
    {
        info!("Application is up-to-date.");
        return Ok(UpdateResult::UpToDate);
    }
    info!("Found newer release: v{}", latest_release.version);

    let asset = if let Some(asset) = latest_release.asset_for(update.target().as_str(), None) {
        asset
    } else {
        error!(
            "Release {} did not contain asset for target {}",
            latest_release.name,
            update.target().as_str()
        );
        return Err(UpdateError::NoCompatibleAssetFound);
    };

    writeln!(stdout, "\nNew release found:")?;
    writeln!(
        stdout,
        "  * Current release is: v{}",
        update.current_version()
    )?;
    writeln!(
        stdout,
        "  * Found release: {} v{}",
        asset.name, latest_release.version
    )?;
    writeln!(stdout, "  * Download url: {}", asset.download_url)?;

    writeln!(
        stdout,
        "\nThe new release will be downloaded and the existing binary will be replaced."
    )?;

    if !config.always_update {
        write!(stdout, "\nDo you want to continue? [Y/n] ")?;
        stdout.flush()?;

        let mut response = String::new();
        stdin.read_line(&mut response)?;
        let response = response.trim().to_lowercase();
        if !response.is_empty() && response != "y" {
            info!("User aborted update.");
            return Err(UpdateError::UserCanceled);
        }
    } else {
        writeln!(
            stdout,
            "\nAutomatic update enabled, proceeding with update..."
        )?;
        info!("Automatic update in progress");
    }

    let tmp_dir = tempfile::TempDir::new()?;
    let path_in_archive = format!("ppoker-{}/{}", update.target(), update.bin_name());
    let binary = update.download_and_extract(&asset, tmp_dir.path(), &path_in_archive)?;

    info!(
        "Replacing binary file {:?} with {:?}",
        update.bin_install_path(),
        binary
    );

    if config.keep_backup_on_update {
        info!("Creating backup of current binary");
        if let Err(e) = binary_ops.backup_binary(update.bin_install_path().as_path()) {
            error!("Failed to create backup: {}", e);
        }
    }

    binary_ops.self_replace(binary.as_path())?;
    info!("Update to v{} done.", latest_release.version);

    let result = UpdateResult::Updated;

    info!("Update successful, restarting application...");
    restarter.restart(&exe_path);

    Ok(result)
}

#[cfg(test)]
mod tests;
