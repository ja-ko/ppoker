use std::fs;
use std::io::{stdin, stdout, BufReader};
use std::path::{Path, PathBuf};
use std::process;

use crate::config::Config;
use log::{debug, error, info};
use self_update::{cargo_crate_version, Extract};
use semver::Version;
use snafu::Snafu;

#[cfg(test)]
use mockall::{automock, predicate::*};
use self_update::self_replace::self_replace;
use subprocess::{Exec};

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
    UpdateError { error: self_update::errors::Error },
    #[snafu(display("An io error occured during the update: {error}"))]
    Io { error: std::io::Error },
    #[snafu(display("Failed to parse semver: {error}"))]
    SemVer { error: semver::Error },
}

impl From<self_update::errors::Error> for UpdateError {
    fn from(value: self_update::errors::Error) -> Self {
        UpdateError::UpdateError { error: value }
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
trait CrateVersion {
    fn version(&self) -> &str;
}

struct DefaultCrateVersion;

impl Default for DefaultCrateVersion {
    fn default() -> Self {
        Self
    }
}

impl CrateVersion for DefaultCrateVersion {
    fn version(&self) -> &str {
        cargo_crate_version!()
    }
}

#[cfg_attr(test, automock)]
pub trait Restarter {
    fn restart(&self, exe_path: &PathBuf);
}

struct DefaultRestarter;

impl Default for DefaultRestarter {
    fn default() -> Self {
        Self
    }
}

impl Restarter for DefaultRestarter {
    fn restart(&self, exe_path: &PathBuf) {
        println!("{}", exe_path.to_str().unwrap());
        Exec::cmd(exe_path)
            .arg("--changelog-from")
            .arg(format!("{}", cargo_crate_version!()))
            .popen()
            .expect("Failed to start new binary");
        info!("Successfully executed updated binary, exiting.");
        process::exit(0);
    }
}

pub fn self_update(config: &Config) -> Result<UpdateResult, UpdateError> {
    self_update_impl(
        config,
        &mut stdout(),
        &mut BufReader::new(stdin()),
        &DefaultCrateVersion::default(),
        &DefaultBinaryOperations::default(),
        &DefaultRestarter::default(),
    )
}

fn self_update_impl<W: std::io::Write, R: std::io::BufRead>(
    config: &Config,
    stdout: &mut W,
    stdin: &mut R,
    version_provider: &impl CrateVersion,
    binary_ops: &impl BinaryOperations,
    restarter: &impl Restarter,
) -> Result<UpdateResult, UpdateError> {
    let exe_path = std::env::current_exe()?;

    let update = self_update::backends::github::Update::configure()
        .repo_owner(GITHUB_OWNER)
        .repo_name(GITHUB_REPO)
        .bin_name(GITHUB_REPO)
        .show_download_progress(true)
        .current_version(version_provider.version())
        .show_output(false)
        .bin_path_in_archive(BIN_PATH_TEMPLATE)
        .build()?;

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
        return Err(UpdateError::NoCompatibleAssetFound.into());
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
        writeln!(stdout, "\nAutomatic update enabled, proceeding with update...")?;
        info!("Automatic update in progress");
    }

    let tmp_dir = tempfile::TempDir::new()?;
    let tmp_tarball_path = tmp_dir.path().join(&asset.name);
    let tmp_tarball = ::std::fs::File::create(&tmp_tarball_path)?;

    info!("Downloading release asset to {:?}.", tmp_tarball_path);

    self_update::Download::from_url(&asset.download_url)
        .set_header(
            reqwest::header::ACCEPT,
            "application/octet-stream".parse().unwrap(),
        )
        .show_progress(true)
        .download_to(&tmp_tarball)?;

    let path_in_archive = format!("ppoker-{}/{}", update.target(), update.bin_name());
    let filename = path_in_archive.as_str();
    info!("Extracting {} from archive.", filename);
    Extract::from_source(&tmp_tarball_path).extract_file(tmp_dir.path(), filename)?;
    let binary = tmp_dir.path().join(filename);

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
mod tests {
    use super::*;
    use mockall::predicate;
    use std::io::Cursor;

    #[test]
    fn test_self_update() {
        let mut mock_config = Config::default();
        mock_config.keep_backup_on_update = true;

        let mut output = Vec::new();

        let mut mock_version = MockCrateVersion::new();
        mock_version
            .expect_version()
            .return_const("0.0.1".to_string());

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
            &mock_version,
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

        let mut mock_version = MockCrateVersion::new();
        mock_version
            .expect_version()
            .return_const("999.0.0".to_string());

        let mock_binary_ops = MockBinaryOperations::default();
        let mock_restarter = MockRestarter::new();
        let mut input = Cursor::new("");

        let result = self_update_impl(
            &mock_config,
            &mut output,
            &mut input,
            &mock_version,
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

        let mut mock_version = MockCrateVersion::new();
        mock_version
            .expect_version()
            .return_const("0.0.1".to_string());

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
            &mock_version,
            &mock_binary_ops,
            &mock_restarter,
        );

        assert!(matches!(result, Err(UpdateError::UserCanceled)));

        let output_str = String::from_utf8(output).unwrap();
        assert!(output_str.contains("Do you want to continue?"));
    }
}
