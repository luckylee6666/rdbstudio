//! Bounded, atomic local libraries with optimistic revisions.
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub const MAX_PRESETS: usize = 100;
pub trait PresetContent: Clone + Serialize + DeserializeOwned {
    const FILE_NAME: &'static str;
    const MAX_FILE_BYTES: usize;
    fn validate(&self) -> AppResult<()>;
    fn namespace(&self) -> String;
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preset<C> {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub content: C,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest<C> {
    pub id: Option<String>,
    pub revision: Option<String>,
    pub name: String,
    #[serde(flatten)]
    pub content: C,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File<C> {
    version: u32,
    presets: Vec<Preset<C>>,
}
impl<C> Default for File<C> {
    fn default() -> Self {
        Self {
            version: 1,
            presets: vec![],
        }
    }
}

pub struct PresetStore<C> {
    pub(crate) path: PathBuf,
    inner: Mutex<()>,
    content: std::marker::PhantomData<C>,
}
struct FileLock(std::fs::File);
impl Drop for FileLock {
    fn drop(&mut self) {
        // Explicitly release: a concurrent process spawn may briefly inherit the fd
        // before exec closes it; relying only on close can retain the lock meanwhile.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}
fn error(code: &str) -> AppError {
    AppError::msg(format!("preset_{code}"))
}
fn name(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 || trimmed.chars().any(char::is_control)
    {
        return Err(error("name"));
    }
    Ok(trimmed.to_owned())
}
impl<C: PresetContent> PresetStore<C> {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(C::FILE_NAME),
            inner: Mutex::new(()),
            content: std::marker::PhantomData,
        }
    }
    fn lock_file(&self) -> AppResult<FileLock> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Stable sidecar inode: never lock the JSON file that atomic replacement swaps.
        let lock = options
            .open(self.path.with_extension("lock"))
            .map_err(|_| error("storage"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match fs2::FileExt::try_lock_exclusive(&lock) {
                Ok(()) => return Ok(FileLock(lock)),
                Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        return Err(error("conflict"));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => return Err(error("storage")),
            }
        }
    }
    // Call only while holding both instance and sidecar locks.
    fn read_file(&self) -> AppResult<File<C>> {
        let file = match std::fs::File::open(&self.path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(C::MAX_FILE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| error("storage"))?;
                if bytes.len() > C::MAX_FILE_BYTES {
                    return Err(error("size"));
                }
                let file: File<C> = serde_json::from_slice(&bytes).map_err(|_| error("corrupt"))?;
                if file.version != 1 || file.presets.len() > MAX_PRESETS {
                    return Err(error("corrupt"));
                }
                let mut ids = HashSet::new();
                let mut names = HashSet::new();
                for p in &file.presets {
                    if uuid::Uuid::parse_str(&p.id).is_err()
                        || uuid::Uuid::parse_str(&p.revision).is_err()
                        || !ids.insert(&p.id)
                        || name(&p.name).is_err()
                        || !names.insert((p.content.namespace(), p.name.to_lowercase()))
                        || p.content.validate().is_err()
                    {
                        return Err(error("corrupt"));
                    }
                }
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => File::default(),
            Err(_) => return Err(error("storage")),
        };
        Ok(file)
    }
    fn persist(&self, file: &File<C>) -> AppResult<()> {
        let bytes = serde_json::to_vec(file).map_err(|_| error("storage"))?;
        if bytes.len() > C::MAX_FILE_BYTES {
            return Err(error("size"));
        }
        let parent = self.path.parent().ok_or_else(|| error("storage"))?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| error("storage"))?;
        // NamedTempFile is private (0600 on Unix); replacement is atomic.
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| error("storage"))?;
        temp.persist(&self.path).map_err(|_| error("storage"))?;
        Ok(())
    }
    pub fn summaries<S>(&self, summarize: impl Fn(&Preset<C>) -> S) -> AppResult<Vec<S>> {
        let _guard = self.inner.lock();
        let _file_lock = self.lock_file()?;
        Ok(self.read_file()?.presets.iter().map(summarize).collect())
    }
    pub fn get(&self, id: &str) -> AppResult<Preset<C>> {
        let _guard = self.inner.lock();
        let _file_lock = self.lock_file()?;
        self.read_file()?
            .presets
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| error("not_found"))
    }
    pub fn save(&self, request: SaveRequest<C>) -> AppResult<Preset<C>> {
        let name = name(&request.name)?;
        request.content.validate()?;
        let _guard = self.inner.lock();
        let _file_lock = self.lock_file()?;
        let mut next = self.read_file()?;
        let index = if let Some(id) = &request.id {
            let index = next
                .presets
                .iter()
                .position(|p| &p.id == id)
                .ok_or_else(|| error("not_found"))?;
            if request.revision.as_deref() != Some(&next.presets[index].revision) {
                return Err(error("conflict"));
            }
            Some(index)
        } else {
            if request.revision.is_some() {
                return Err(error("invalid"));
            }
            if next.presets.len() >= MAX_PRESETS {
                return Err(error("limit"));
            }
            None
        };
        if next.presets.iter().enumerate().any(|(i, p)| {
            Some(i) != index
                && p.content.namespace() == request.content.namespace()
                && p.name.to_lowercase() == name.to_lowercase()
        }) {
            return Err(error("duplicate"));
        }
        let preset = Preset {
            id: request
                .id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision: uuid::Uuid::new_v4().to_string(),
            name,
            updated_at: chrono::Utc::now().to_rfc3339(),
            content: request.content,
        };
        if let Some(index) = index {
            next.presets[index] = preset.clone();
        } else {
            next.presets.push(preset.clone());
        }
        self.persist(&next)?;
        Ok(preset)
    }
    pub fn rename(&self, id: &str, revision: &str, value: &str) -> AppResult<Preset<C>> {
        // save rechecks revision under the same mutation lock, including races
        // between this read and another tab's update/delete.
        let preset = self.get(id)?;
        self.save(SaveRequest {
            id: Some(id.to_owned()),
            revision: Some(revision.to_owned()),
            name: value.to_owned(),
            content: preset.content,
        })
    }
    pub fn delete(&self, id: &str, revision: &str) -> AppResult<()> {
        let _guard = self.inner.lock();
        let _file_lock = self.lock_file()?;
        let current = self.read_file()?;
        let index = current
            .presets
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| error("not_found"))?;
        if current.presets[index].revision != revision {
            return Err(error("conflict"));
        }
        let mut next = current;
        next.presets.remove(index);
        self.persist(&next)?;
        Ok(())
    }
}
