//! Explicitly saved parameter presets; listing never returns stored values.
use crate::{
    db::parameters::{self, ParameterKind, QueryParameter},
    error::{AppError, AppResult},
    model::DriverKind,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
#[cfg(test)]
use crate::named_presets::MAX_PRESETS;

#[derive(Clone, Deserialize, Serialize)]
pub struct Definition {
    pub name: String,
    pub kind: ParameterKind,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Single,
    Batch,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Content {
    pub driver: DriverKind,
    pub mode: Mode,
    pub parameters: Vec<Definition>,
    pub atomic: bool,
    // None means definitions only, not a row of SQL NULLs.
    pub sets: Option<Vec<Vec<QueryParameter>>>,
}
pub type Preset = crate::named_presets::Preset<Content>;
pub type SaveRequest = crate::named_presets::SaveRequest<Content>;
#[derive(Serialize)]
pub struct Summary {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub updated_at: String,
    pub driver: DriverKind,
    pub mode: Mode,
    pub parameters: Vec<Definition>,
    pub set_count: usize,
    pub has_values: bool,
}
pub struct PresetStore(crate::named_presets::PresetStore<Content>);
impl std::ops::Deref for PresetStore {
    type Target = crate::named_presets::PresetStore<Content>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
fn error(code: &str) -> AppError {
    AppError::msg(format!("preset_{code}"))
}
impl crate::named_presets::PresetContent for Content {
    const FILE_NAME: &'static str = "parameter-presets.json";
    const MAX_FILE_BYTES: usize = MAX_FILE_BYTES;
    fn validate(&self) -> AppResult<()> {
        validate(self)
    }
    fn namespace(&self) -> String {
        format!("{:?}", self.driver)
    }
}
fn validate(content: &Content) -> AppResult<()> {
    if content.driver == DriverKind::Redis
        || content.parameters.is_empty()
        || content.parameters.len() > 128
    {
        return Err(error("invalid"));
    }
    let schema: Vec<_> = content
        .parameters
        .iter()
        .map(|p| QueryParameter {
            name: p.name.clone(),
            kind: p.kind,
            value: None,
        })
        .collect();
    parameters::validate_values(&schema, content.driver).map_err(|_| error("invalid"))?;
    if let Some(sets) = &content.sets {
        if sets.is_empty() || sets.len() > 100 || (content.mode == Mode::Single && sets.len() != 1)
        {
            return Err(error("invalid"));
        }
        let mut bytes = 0usize;
        for set in sets {
            if set.len() != schema.len()
                || set
                    .iter()
                    .any(|p| !schema.iter().any(|s| s.name == p.name && s.kind == p.kind))
            {
                return Err(error("invalid"));
            }
            parameters::validate_values(set, content.driver).map_err(|_| error("invalid"))?;
            bytes += set
                .iter()
                .map(|p| p.value.as_ref().map_or(0, String::len))
                .sum::<usize>();
            if bytes > 8 * 1024 * 1024 {
                return Err(error("size"));
            }
        }
    }
    Ok(())
}
impl PresetStore {
    pub fn new(directory: &Path) -> Self {
        Self(crate::named_presets::PresetStore::new(directory))
    }
    pub fn list(&self) -> AppResult<Vec<Summary>> {
        self.summaries(|p| Summary {
            id: p.id.clone(),
            revision: p.revision.clone(),
            name: p.name.clone(),
            updated_at: p.updated_at.clone(),
            driver: p.content.driver,
            mode: p.content.mode,
            parameters: p.content.parameters.clone(),
            set_count: p.content.sets.as_ref().map_or(0, Vec::len),
            has_values: p.content.sets.is_some(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_limits_reject_oversized_batches_and_stores_before_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let mut oversized = request(false);
        oversized.content.parameters[0].kind = ParameterKind::Text;
        oversized.content.sets = Some(
            (0..9)
                .map(|_| {
                    vec![QueryParameter {
                        name: "amount".into(),
                        kind: ParameterKind::Text,
                        value: Some("x".repeat(1024 * 1024)),
                    }]
                })
                .collect(),
        );
        assert_eq!(
            store.save(oversized).err().unwrap().to_string(),
            "preset_size"
        );
        assert!(!store.path.exists());
        for index in 0..MAX_PRESETS {
            let mut item = request(false);
            item.name = format!("Preset {index}");
            store.save(item).unwrap();
        }
        assert_eq!(
            store.save(request(false)).err().unwrap().to_string(),
            "preset_limit"
        );
        assert_eq!(store.list().unwrap().len(), MAX_PRESETS);
        // Reading a too-large existing file must not parse or overwrite it.
        std::fs::File::create(&store.path)
            .unwrap()
            .set_len(MAX_FILE_BYTES as u64 + 1)
            .unwrap();
        let reopened = PresetStore::new(dir.path());
        assert_eq!(reopened.list().err().unwrap().to_string(), "preset_size");
        assert_eq!(
            std::fs::metadata(&store.path).unwrap().len(),
            MAX_FILE_BYTES as u64 + 1
        );
    }
    fn request(with_values: bool) -> SaveRequest {
        SaveRequest {
            id: None,
            revision: None,
            name: " Orders ".into(),
            content: Content {
                driver: DriverKind::Sqlite,
                mode: Mode::Batch,
                atomic: true,
                parameters: vec![Definition {
                    name: "amount".into(),
                    kind: ParameterKind::Integer,
                }],
                sets: with_values.then(|| {
                    vec![
                        vec![QueryParameter {
                            name: "amount".into(),
                            kind: ParameterKind::Integer,
                            value: Some("9223372036854775807".into()),
                        }],
                        vec![QueryParameter {
                            name: "amount".into(),
                            kind: ParameterKind::Integer,
                            value: None,
                        }],
                    ]
                }),
            },
        }
    }
    #[test]
    fn explicit_values_roundtrip_but_list_returns_only_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        assert!(store.list().unwrap().is_empty());
        assert!(!store.path.exists());
        let saved = store.save(request(true)).unwrap();
        assert_eq!(saved.name, "Orders");
        let json = serde_json::to_string(&store.list().unwrap()).unwrap();
        assert!(!json.contains("9223372036854775807"));
        assert!(json.contains("\"set_count\":2"));
        let restarted = PresetStore::new(dir.path());
        let loaded = restarted.get(&saved.id).unwrap();
        assert_eq!(
            loaded.content.sets.as_ref().unwrap()[0][0].value.as_deref(),
            Some("9223372036854775807")
        );
        assert!(loaded.content.sets.as_ref().unwrap()[1][0].value.is_none());
        let mut replacement = request(false);
        replacement.id = Some(saved.id.clone());
        replacement.revision = Some(saved.revision.clone());
        let replaced = store.save(replacement).unwrap();
        assert!(replaced.content.sets.is_none());
        assert!(!std::fs::read_to_string(&store.path)
            .unwrap()
            .contains("9223372036854775807"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn revisions_protect_replacement_rename_and_delete_across_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let first = store.save(request(true)).unwrap();
        let renamed = store.rename(&first.id, &first.revision, "Updated").unwrap();
        assert!(renamed.content.sets.is_some());
        let mut stale = request(false);
        stale.id = Some(first.id.clone());
        stale.revision = Some(first.revision.clone());
        assert_eq!(
            store.save(stale).err().unwrap().to_string(),
            "preset_conflict"
        );
        assert!(store.delete(&first.id, &first.revision).is_err());
        assert!(store.rename(&first.id, &first.revision, "Stale").is_err());
        assert_eq!(store.get(&first.id).unwrap().name, "Updated");
        store.delete(&renamed.id, &renamed.revision).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(PresetStore::new(dir.path()).list().unwrap().is_empty());
    }
    #[test]
    fn invalid_presets_and_duplicate_names_never_replace_valid_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let first = store.save(request(false)).unwrap();
        let mut duplicate = request(false);
        duplicate.name = "orders".into();
        assert_eq!(
            store.save(duplicate).err().unwrap().to_string(),
            "preset_duplicate"
        );
        for variant in 0..5 {
            let mut bad = request(true);
            bad.name = "Bad".into();
            match variant {
                0 => bad
                    .content
                    .parameters
                    .push(bad.content.parameters[0].clone()),
                1 => bad.content.sets.as_mut().unwrap()[0][0].kind = ParameterKind::Text,
                2 => {
                    bad.content.sets.as_mut().unwrap()[0][0].value =
                        Some("sensitive-invalid-integer".into())
                }
                3 => bad.content.mode = Mode::Single,
                _ => bad.content.driver = DriverKind::Redis,
            }
            let error = store.save(bad).err().unwrap().to_string();
            assert!(!error.contains("sensitive-invalid-integer"));
        }
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.get(&first.id).unwrap().revision, first.revision);
    }
    #[test]
    fn failed_persistence_keeps_memory_and_corrupt_files_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let first = store.save(request(false)).unwrap();
        // Make atomic replacement fail without depending on user permissions.
        let original = std::fs::read(&store.path).unwrap();
        std::fs::remove_file(&store.path).unwrap();
        std::fs::create_dir(&store.path).unwrap();
        assert!(store.rename(&first.id, &first.revision, "Lost").is_err());
        std::fs::remove_dir(&store.path).unwrap();
        std::fs::write(&store.path, original).unwrap();
        assert_eq!(store.get(&first.id).unwrap().name, "Orders");
        let corrupt = b"{unreadable but valuable}";
        std::fs::write(&store.path, corrupt).unwrap();
        let reopened = PresetStore::new(dir.path());
        assert_eq!(reopened.list().err().unwrap().to_string(), "preset_corrupt");
        assert!(reopened.save(request(false)).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), corrupt);
    }
    #[test]
    fn concurrent_writers_with_the_same_revision_cannot_both_win() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(PresetStore::new(dir.path()));
        let first = store.save(request(false)).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let store = store.clone();
                let barrier = barrier.clone();
                let first = first.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .rename(&first.id, &first.revision, &format!("Writer {index}"))
                        .is_ok()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .filter_map(|h| h.join().unwrap().then_some(()))
                .count(),
            1
        );
    }
}
