use crate::error::AppResult;
use std::path::{Path, PathBuf};

const DATA_DIR_NAME: &str = ".rdbstudio";
const MIGRATION_MARKER: &str = ".legacy-app-data-migrated-v1";
const STORE_FILES: &[&str] = &[
    "connections.json",
    "history.json",
    "snippets.json",
    "connections.json.corrupt",
    "history.json.corrupt",
    "snippets.json.corrupt",
];

/// Resolve the durable user-data directory and migrate stores from Tauri's
/// platform app-data directory on first launch.
///
/// The destination lives directly below the user's home directory so app
/// uninstallers do not mistake it for disposable application support data.
/// Migration is copy-only: existing destination files win and legacy files
/// are never removed.
pub fn prepare_data_dir(home_dir: &Path, legacy_data_dir: &Path) -> AppResult<PathBuf> {
    let data_dir = home_dir.join(DATA_DIR_NAME);
    std::fs::create_dir_all(&data_dir)?;
    restrict_directory_permissions(&data_dir)?;

    if data_dir != legacy_data_dir {
        migrate_legacy_stores(legacy_data_dir, &data_dir)?;
    }

    Ok(data_dir)
}

fn migrate_legacy_stores(legacy_data_dir: &Path, data_dir: &Path) -> AppResult<()> {
    let marker = data_dir.join(MIGRATION_MARKER);
    if marker.exists() {
        return Ok(());
    }

    for name in STORE_FILES {
        let source = legacy_data_dir.join(name);
        let destination = data_dir.join(name);
        if !source.is_file() || destination.exists() {
            continue;
        }

        let temporary = data_dir.join(format!(".{name}.migration.tmp"));
        let copy_result = (|| -> std::io::Result<()> {
            std::fs::copy(&source, &temporary)?;
            std::fs::rename(&temporary, &destination)
        })();
        if let Err(error) = copy_result {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
    }

    let temporary_marker = data_dir.join(format!("{MIGRATION_MARKER}.tmp"));
    std::fs::write(&temporary_marker, b"1\n")?;
    std::fs::rename(temporary_marker, marker)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_known_files_without_removing_legacy_data() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let legacy = root.path().join("legacy");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&legacy).expect("legacy");
        std::fs::write(legacy.join("connections.json"), b"old connections")
            .expect("write connections");
        std::fs::write(legacy.join("history.json"), b"old history").expect("write history");
        std::fs::write(legacy.join("unrelated.txt"), b"do not migrate")
            .expect("write unrelated");

        let data_dir = prepare_data_dir(&home, &legacy).expect("prepare data dir");

        assert_eq!(data_dir, home.join(".rdbstudio"));
        assert_eq!(
            std::fs::read(data_dir.join("connections.json")).expect("read migrated connections"),
            b"old connections"
        );
        assert_eq!(
            std::fs::read(data_dir.join("history.json")).expect("read migrated history"),
            b"old history"
        );
        assert!(legacy.join("connections.json").exists());
        assert!(legacy.join("history.json").exists());
        assert!(!data_dir.join("unrelated.txt").exists());
        assert!(data_dir.join(MIGRATION_MARKER).exists());
    }

    #[test]
    fn migration_never_overwrites_an_existing_destination() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let legacy = root.path().join("legacy");
        let data_dir = home.join(".rdbstudio");
        std::fs::create_dir_all(&data_dir).expect("data dir");
        std::fs::create_dir_all(&legacy).expect("legacy");
        std::fs::write(legacy.join("connections.json"), b"legacy").expect("legacy file");
        std::fs::write(data_dir.join("connections.json"), b"current").expect("current file");

        prepare_data_dir(&home, &legacy).expect("prepare data dir");

        assert_eq!(
            std::fs::read(data_dir.join("connections.json")).expect("read current file"),
            b"current"
        );
        assert_eq!(
            std::fs::read(legacy.join("connections.json")).expect("read legacy file"),
            b"legacy"
        );
    }

    #[test]
    fn completed_migration_does_not_resurrect_stale_legacy_data() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let legacy = root.path().join("legacy");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&legacy).expect("legacy");

        let data_dir = prepare_data_dir(&home, &legacy).expect("first prepare");
        std::fs::write(legacy.join("connections.json"), b"stale").expect("stale legacy file");
        prepare_data_dir(&home, &legacy).expect("second prepare");

        assert!(!data_dir.join("connections.json").exists());
    }

    #[test]
    fn failed_copy_keeps_the_legacy_file_and_does_not_mark_migration_complete() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let legacy = root.path().join("legacy");
        let data_dir = home.join(".rdbstudio");
        std::fs::create_dir_all(&data_dir).expect("data dir");
        std::fs::create_dir_all(&legacy).expect("legacy");
        std::fs::write(legacy.join("connections.json"), b"legacy").expect("legacy file");
        std::fs::create_dir(data_dir.join(".connections.json.migration.tmp"))
            .expect("blocking temp directory");

        assert!(prepare_data_dir(&home, &legacy).is_err());
        assert_eq!(
            std::fs::read(legacy.join("connections.json")).expect("legacy file remains"),
            b"legacy"
        );
        assert!(!data_dir.join(MIGRATION_MARKER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn data_directory_is_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let legacy = root.path().join("legacy");
        std::fs::create_dir_all(&home).expect("home");

        let data_dir = prepare_data_dir(&home, &legacy).expect("prepare data dir");
        let mode = std::fs::metadata(data_dir)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(mode, 0o700);
    }
}
