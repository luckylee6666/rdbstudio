//! Offline relational model documents. No live connection or SQL is accepted.
use crate::{
    error::{AppError, AppResult},
    named_presets,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
const MODEL_BYTES: usize = 2 * 1024 * 1024;
// Extension fields may be absent, but explicit null is invalid.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
    pub comment: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UniqueKey {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub id: String,
    pub name: String,
    pub schema: String,
    pub comment: String,
    pub position: Position,
    pub columns: Vec<Column>,
    #[serde(default, rename = "primaryKey", skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub primary_key: Option<Vec<String>>,
    #[serde(default, rename = "uniqueKeys", skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub unique_keys: Option<Vec<UniqueKey>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub name: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_table: String,
    pub to_columns: Vec<String>,
    pub cardinality: String,
    pub identifying: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub on_delete: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub version: u32,
    pub dialect: String,
    pub tables: Vec<Table>,
    pub relations: Vec<Relation>,
}
#[derive(Clone, Serialize)]
pub struct Content {
    pub model: Model,
}
// Decode the flattened content through Value: arbitrary_precision numbers in
// Serde's buffered flatten representation are maps rather than f64 visitors.
impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            model: serde_json::Value,
        }
        let raw = Raw::deserialize(deserializer)?;
        let model = serde_json::from_value(raw.model).map_err(serde::de::Error::custom)?;
        Ok(Self { model })
    }
}
pub type Record = named_presets::Preset<Content>;
pub type SaveRequest = named_presets::SaveRequest<Content>;
#[derive(Serialize)]
pub struct Summary {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub updated_at: String,
    pub dialect: String,
    pub tables: usize,
    pub relations: usize,
}
pub struct ModelStore(named_presets::PresetStore<Content>);
impl std::ops::Deref for ModelStore {
    type Target = named_presets::PresetStore<Content>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl ModelStore {
    pub fn new(directory: &Path) -> Self {
        Self(named_presets::PresetStore::new(directory))
    }
    pub fn list(&self) -> AppResult<Vec<Summary>> {
        self.summaries(|p| Summary {
            id: p.id.clone(),
            revision: p.revision.clone(),
            name: p.name.clone(),
            updated_at: p.updated_at.clone(),
            dialect: p.content.model.dialect.clone(),
            tables: p.content.model.tables.len(),
            relations: p.content.model.relations.len(),
        })
    }
}
fn invalid() -> AppError {
    AppError::msg("model_invalid")
}
fn text(s: &str, max: usize, empty: bool, multiline: bool) -> bool {
    s.encode_utf16().count() <= max
        && (empty || !s.trim().is_empty())
        && !s.chars().any(|c| {
            (c <= '\u{1f}' || c == '\u{7f}') && !(multiline && matches!(c, '\n' | '\r' | '\t'))
        })
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
impl named_presets::PresetContent for Content {
    const FILE_NAME: &'static str = "offline-models.json";
    const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
    fn namespace(&self) -> String {
        "models".into()
    }
    fn validate(&self) -> AppResult<()> {
        let m = &self.model;
        if !matches!(m.version, 1 | 2)
            || !matches!(m.dialect.as_str(), "sqlite" | "postgres" | "mysql")
            || m.tables.len() > 200
            || m.relations.len() > 1000
            || serde_json::to_vec(m).map_err(|_| invalid())?.len() > MODEL_BYTES
        {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        let mut count = 0;
        let mut key_count = 0;
        let mut constraint_names = HashSet::new();
        let mut tables = HashMap::new();
        for t in &m.tables {
            if !id(&t.id)
                || !ids.insert(&t.id)
                || !text(&t.name, 128, false, false)
                || !text(&t.schema, 128, true, false)
                || !text(&t.comment, 4096, true, true)
                || t.columns.len() > 256
                || ![t.position.x, t.position.y]
                    .iter()
                    .all(|v| v.is_finite() && v.abs() <= 1_000_000.0)
                || !names.insert((t.schema.to_lowercase(), t.name.to_lowercase()))
            {
                return Err(invalid());
            }
            let mut columns = HashSet::new();
            let mut column_names = HashSet::new();
            count += t.columns.len();
            for c in &t.columns {
                if !id(&c.id)
                    || !ids.insert(&c.id)
                    || !text(&c.name, 128, false, false)
                    || !text(&c.r#type, 256, false, false)
                    || !text(&c.comment, 4096, true, true)
                    || (c.primary_key && c.nullable)
                    || !column_names.insert(c.name.to_lowercase())
                {
                    return Err(invalid());
                }
                columns.insert(c.id.as_str());
            }
            if m.version == 1 && (t.primary_key.is_some() || t.unique_keys.is_some()) {
                return Err(invalid());
            }
            if let Some(primary) = &t.primary_key {
                let flags: HashSet<&str> = t.columns.iter().filter(|c| c.primary_key).map(|c| c.id.as_str()).collect();
                let ordered: HashSet<&str> = primary.iter().map(String::as_str).collect();
                if primary.len() != ordered.len() || flags != ordered { return Err(invalid()); }
            }
            if let Some(keys) = &t.unique_keys {
                if keys.len() > 64 { return Err(invalid()); }
                key_count += keys.len();
                for key in keys {
                    let refs: HashSet<&str> = key.columns.iter().map(String::as_str).collect();
                    if !id(&key.id) || !ids.insert(&key.id) || !text(&key.name, 128, false, false)
                        || !constraint_names.insert((&t.id, key.name.to_lowercase()))
                        || key.columns.is_empty() || key.columns.len() > 256 || refs.len() != key.columns.len()
                        || !refs.is_subset(&columns) { return Err(invalid()); }
                }
            }
            tables.insert(t.id.as_str(), columns);
        }
        if count > 4096 || key_count > 1000 {
            return Err(invalid());
        }
        for r in &m.relations {
            if !id(&r.id)
                || !ids.insert(&r.id)
                || !text(&r.name, 128, false, false)
                || !constraint_names.insert((&r.from_table, r.name.to_lowercase()))
                || !matches!(r.cardinality.as_str(), "one-one" | "one-many")
                || r.from_columns.is_empty()
                || r.from_columns.len() > 16
                || r.from_columns.len() != r.to_columns.len()
                || (m.version == 1 && (r.on_update.is_some() || r.on_delete.is_some()))
                || [&r.on_update, &r.on_delete].iter().any(|action| action.as_deref().is_some_and(|a| !matches!(a, "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT")))
            {
                return Err(invalid());
            }
            for (table, columns) in [
                (&r.from_table, &r.from_columns),
                (&r.to_table, &r.to_columns),
            ] {
                let available = tables.get(table.as_str()).ok_or_else(invalid)?;
                let mut used = HashSet::new();
                for column in columns {
                    if !available.contains(column.as_str()) || !used.insert(column) {
                        return Err(invalid());
                    }
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::named_presets::PresetContent;
    fn content() -> Content {
        serde_json::from_value(serde_json::json!({"model":{"version":1,"dialect":"sqlite","tables":[{"id":"t","name":"items","schema":"","comment":"","position":{"x":0,"y":0},"columns":[{"id":"c","name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"unique":false,"comment":""}]}],"relations":[]}})).unwrap()
    }
    #[test]
    fn version_two_keys_and_actions_persist_and_validate() {
        let mut raw = serde_json::to_value(content()).unwrap();
        raw["model"]["version"] = 2.into();
        raw["model"]["tables"][0]["primaryKey"] = serde_json::json!(["c"]);
        raw["model"]["tables"][0]["uniqueKeys"] = serde_json::json!([{"id":"uq","name":"unique_id","columns":["c"]}]);
        raw["model"]["relations"] = serde_json::json!([{"id":"fk","name":"self_ref","fromTable":"t","fromColumns":["c"],"toTable":"t","toColumns":["c"],"cardinality":"one-many","identifying":false,"onUpdate":"CASCADE","onDelete":"RESTRICT"}]);
        let value: Content = serde_json::from_value(raw.clone()).unwrap();
        value.validate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(dir.path());
        let saved = store.save(SaveRequest { id: None, revision: None, name: "v2".into(), content: value }).unwrap();
        let reopened = ModelStore::new(dir.path()).get(&saved.id).unwrap();
        assert_eq!(serde_json::to_value(reopened.content).unwrap(), raw);
        for (field, bad) in [("primaryKey", serde_json::json!([])), ("uniqueKeys", serde_json::json!([{"id":"uq","name":"self_ref","columns":["c"]}]))] {
            let mut invalid = raw.clone(); invalid["model"]["tables"][0][field] = bad;
            assert!(serde_json::from_value::<Content>(invalid).unwrap().validate().is_err());
        }
        let mut legacy = raw.clone(); legacy["model"]["version"] = 1.into();
        assert!(serde_json::from_value::<Content>(legacy).unwrap().validate().is_err());
        let mut bad_action = raw.clone(); bad_action["model"]["relations"][0]["onDelete"] = "CASCADE; DROP TABLE x".into();
        assert!(serde_json::from_value::<Content>(bad_action).unwrap().validate().is_err());
        raw["model"]["tables"][0]["primaryKey"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Content>(raw).is_err());
    }
    #[test]
    fn validates_references_and_document_limits() {
        let mut c = content();
        c.validate().unwrap();
        c.model.relations.push(Relation {
            id: "r".into(),
            name: "parent".into(),
            from_table: "t".into(),
            from_columns: vec!["c".into()],
            to_table: "t".into(),
            to_columns: vec!["c".into()],
            cardinality: "one-many".into(),
            identifying: false,
            on_update: None,
            on_delete: None,
        });
        c.validate().unwrap();
        c.model.relations[0].to_columns[0] = "missing".into();
        assert!(c.validate().is_err());
        let mut c = content();
        c.model.tables[0].columns[0].nullable = true;
        assert!(c.validate().is_err());
        let mut c = content();
        c.model.tables[0].position.x = f64::NAN;
        assert!(c.validate().is_err());
        let mut c = content();
        c.model.tables[0].columns[0].id = "t".into();
        assert!(c.validate().is_err());
        let mut c = content();
        c.model.tables = vec![c.model.tables[0].clone(); 201];
        assert!(c.validate().is_err());
        let mut c = content();
        c.model.version = 3;
        assert!(c.validate().is_err());
    }
    #[test]
    fn persists_and_rejects_stale_edits() {
        let dir = tempfile::tempdir().unwrap();
        let a = ModelStore::new(dir.path());
        let b = ModelStore::new(dir.path());
        let mut model_content = content();
        model_content.model.tables[0].position = Position {
            x: 123.25,
            y: -0.125,
        };
        let saved = a
            .save(SaveRequest {
                id: None,
                revision: None,
                name: "模型".into(),
                content: model_content,
            })
            .unwrap();
        let raw = serde_json::to_value(&saved).unwrap();
        let _: Record = serde_json::from_value(raw).unwrap();
        let loaded: Record = serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
        loaded.content.validate().unwrap();
        assert_eq!(loaded.content.model.tables[0].position.x, 123.25);
        assert_eq!(loaded.content.model.tables[0].position.y, -0.125);
        let persisted = b.get(&saved.id).unwrap();
        assert_eq!(persisted.content.model.tables[0].position.x, 123.25);
        assert_eq!(persisted.content.model.tables[0].position.y, -0.125);
        assert_eq!(b.get(&saved.id).unwrap().content.model.tables.len(), 1);
        let changed = b
            .save(SaveRequest {
                id: Some(saved.id.clone()),
                revision: Some(saved.revision.clone()),
                name: "模型".into(),
                content: content(),
            })
            .unwrap();
        assert!(a
            .save(SaveRequest {
                id: Some(saved.id.clone()),
                revision: Some(saved.revision.clone()),
                name: "old".into(),
                content: content()
            })
            .is_err());
        assert!(a.delete(&saved.id, &saved.revision).is_err());
        a.delete(&changed.id, &changed.revision).unwrap();
        assert!(b.list().unwrap().is_empty());
    }
    #[test]
    fn rejects_unknown_fields_and_preserves_corrupt_file() {
        let mut raw = serde_json::to_value(content()).unwrap();
        raw["model"]["connectionId"] = serde_json::json!("not-allowed");
        assert!(serde_json::from_value::<Content>(raw).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("offline-models.json");
        std::fs::write(&path, b"broken").unwrap();
        let store = ModelStore::new(dir.path());
        assert!(store
            .save(SaveRequest {
                id: None,
                revision: None,
                name: "test".into(),
                content: content()
            })
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"broken");
    }
}
