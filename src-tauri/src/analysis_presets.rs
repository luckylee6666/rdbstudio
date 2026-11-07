//! Configuration-only analysis library. Source rows/SQL are never accepted.
use crate::{
    error::{AppError, AppResult},
    named_presets,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{cmp::Ordering, collections::HashSet, path::Path};
const CONFIG_BYTES: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub config: Value,
}
pub type Preset = named_presets::Preset<Content>;
pub type SaveRequest = named_presets::SaveRequest<Content>;
#[derive(Serialize)]
pub struct Summary {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub updated_at: String,
    pub mode: String,
    pub chart: String,
    pub has_series_values: bool,
}
pub struct PresetStore(named_presets::PresetStore<Content>);
impl std::ops::Deref for PresetStore {
    type Target = named_presets::PresetStore<Content>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl PresetStore {
    pub fn new(directory: &Path) -> Self {
        Self(named_presets::PresetStore::new(directory))
    }
    pub fn list(&self) -> AppResult<Vec<Summary>> {
        self.summaries(|p| Summary {
            id: p.id.clone(),
            revision: p.revision.clone(),
            name: p.name.clone(),
            updated_at: p.updated_at.clone(),
            mode: p.content.config["mode"].as_str().unwrap_or_default().into(),
            chart: p.content.config["chart"]
                .as_str()
                .unwrap_or_default()
                .into(),
            has_series_values: p.content.config["series"]["mode"] == "keys",
        })
    }
}
fn error(code: &str) -> AppError {
    AppError::msg(format!("preset_{code}"))
}
fn object<'a>(
    v: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> AppResult<&'a Map<String, Value>> {
    let m = v.as_object().ok_or_else(|| error("invalid"))?;
    if required.iter().any(|k| !m.contains_key(*k))
        || m.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(error("invalid"));
    }
    Ok(m)
}
fn text(v: &Value, max: usize) -> AppResult<&str> {
    v.as_str()
        .filter(|s| {
            s.encode_utf16().count() <= max && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        })
        .ok_or_else(|| error("invalid"))
}
fn choice<'a>(v: &'a Value, values: &[&str]) -> AppResult<&'a str> {
    let s = text(v, 64)?;
    if values.contains(&s) {
        Ok(s)
    } else {
        Err(error("invalid"))
    }
}
// Exact decimal comparison without floating conversion or a fixed-precision decimal limit.
// Canonical magnitude contains 768 integer and 768 fractional places, covering 256 digits ±512 exponent.
fn decimal(value: &str) -> Option<(bool, String)> {
    let s = value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'));
    if s.len() > 272 {
        return None;
    }
    let negative = s.starts_with('-');
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    let mut parts = s.split(['e', 'E']);
    let mantissa = parts.next()?;
    let exponent = match parts.next() {
        None => 0,
        Some(e) => {
            let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
            if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            e.parse::<i32>().ok()?
        }
    };
    if parts.next().is_some() || !(-512..=512).contains(&exponent) {
        return None;
    }
    let mut decimal = mantissa.split('.');
    let whole = decimal.next()?;
    let fraction = decimal.next().unwrap_or("");
    if decimal.next().is_some()
        || whole.len() + fraction.len() == 0
        || whole.len() + fraction.len() > 256
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let digits = format!("{whole}{fraction}");
    let start = (768 - whole.len() as i32 - exponent) as usize;
    let mut magnitude = "0".repeat(start);
    magnitude.push_str(&digits);
    magnitude.push_str(&"0".repeat(1536 - magnitude.len()));
    Some((negative && digits.bytes().any(|c| c != b'0'), magnitude))
}
fn less(a: &(bool, String), b: &(bool, String)) -> bool {
    match (a.0, b.0) {
        (true, false) => true,
        (false, true) => false,
        (negative, _) => {
            a.1.cmp(&b.1)
                == if negative {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
        }
    }
}
fn column_binding(value: &Value) -> AppResult<()> {
    let b = object(value, &["name", "dataType", "ordinal"], &[])?;
    text(&b["name"], 512)?;
    text(&b["dataType"], 128)?;
    if b["ordinal"].as_u64().is_none_or(|v| v > 65535) {
        return Err(error("invalid"));
    }
    Ok(())
}
// Formulas are configuration text, never executable JavaScript or SQL. The frontend
// parser validates grammar and references again before mapping/applying; native storage
// enforces a closed data schema, bounded text, IDs, names and reference targets.
fn calculation_definitions(value: &Value) -> AppResult<usize> {
    let c = object(value, &["inputs", "fields"], &[])?;
    let inputs = c["inputs"].as_array().ok_or_else(|| error("invalid"))?;
    let fields = c["fields"].as_array().ok_or_else(|| error("invalid"))?;
    if inputs.len() > 1024 || fields.is_empty() || fields.len() > 16 {
        return Err(error("invalid"));
    }
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    for input in inputs {
        column_binding(input)?;
        names.insert(input["name"].as_str().unwrap().trim().to_lowercase());
    }
    for (index, value) in fields.iter().enumerate() {
        let field = object(value, &["id", "name", "type", "expression"], &[])?;
        let id = text(&field["id"], 64)?;
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || !ids.insert(id)
        {
            return Err(error("invalid"));
        }
        let name = text(&field["name"], 100)?.trim();
        if name.is_empty() || !names.insert(name.to_lowercase()) {
            return Err(error("invalid"));
        }
        choice(&field["type"], &["number", "text", "boolean", "time"])?;
        let expression = field["expression"]
            .as_str()
            .ok_or_else(|| error("invalid"))?;
        if expression.trim().is_empty()
            || expression.encode_utf16().count() > 4096
            || expression
                .chars()
                .any(|c| (c < '\u{20}' && !matches!(c, '\n' | '\r' | '\t')) || c == '\u{7f}')
        {
            return Err(error("invalid"));
        }
        let mut chars = expression.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                let mut closed = false;
                while let Some(c) = chars.next() {
                    if c == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                        } else {
                            closed = true;
                            break;
                        }
                    }
                }
                if !closed {
                    return Err(error("invalid"));
                }
            } else if c == '[' {
                let mut digits = String::new();
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    digits.push(chars.next().unwrap());
                    if digits.len() > 5 {
                        return Err(error("invalid"));
                    }
                }
                let reference = digits.parse::<usize>().map_err(|_| error("invalid"))?;
                if chars.next() != Some(']')
                    || digits.starts_with('0')
                    || reference == 0
                    || reference > inputs.len() + index
                {
                    return Err(error("invalid"));
                }
            }
        }
    }
    Ok(fields.len())
}
impl named_presets::PresetContent for Content {
    const FILE_NAME: &'static str = "analysis-presets.json";
    const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
    fn namespace(&self) -> String {
        String::new()
    }
    fn validate(&self) -> AppResult<()> {
        if serde_json::to_vec(&self.config)
            .map_err(|_| error("invalid"))?
            .len()
            > CONFIG_BYTES
        {
            return Err(error("size"));
        }
        let c = object(
            &self.config,
            &[
                "version",
                "mode",
                "chart",
                "bindings",
                "aggregate",
                "parseStrings",
                "axisKind",
                "timeOptions",
                "metricOptions",
                "sample",
                "series",
            ],
            &["calculations"],
        )?;
        let field_count = match c["version"].as_u64() {
            Some(1) => {
                if c.contains_key("calculations") {
                    return Err(error("invalid"));
                }
                0
            }
            Some(2) => {
                calculation_definitions(c.get("calculations").ok_or_else(|| error("invalid"))?)?
            }
            _ => return Err(error("version")),
        };
        let mode = choice(&c["mode"], &["profile", "pivot", "chart"])?;
        let chart = choice(
            &c["chart"],
            &[
                "bar",
                "stackedBar",
                "horizontalBar",
                "horizontalStackedBar",
                "line",
                "area",
                "stackedArea",
                "combo",
                "stackedCombo",
                "waterfall",
                "tornado",
                "pie",
                "donut",
                "heatmap",
                "treemap",
                "scatter",
                "value",
                "trend",
                "kpi",
                "gauge",
            ],
        )?;
        let (required, optional): (&[&str], &[&str]) = if mode == "profile" {
            (&["profile"], &[])
        } else if mode == "chart" && chart == "scatter" {
            (&["x", "y"], &["label"])
        } else if mode == "chart" && ["value", "kpi", "gauge"].contains(&chart) {
            (&["measure"], &["split"])
        } else {
            (&["row", "measure"], &["split"])
        };
        let bindings = object(&c["bindings"], required, optional)?;
        for b in bindings.values() {
            if b.get("calculated").is_some() {
                let b = object(b, &["calculated"], &[])?;
                if b["calculated"]
                    .as_u64()
                    .is_none_or(|v| v >= field_count as u64)
                {
                    return Err(error("invalid"));
                }
            } else {
                column_binding(b)?;
            }
        }
        choice(
            &c["aggregate"],
            &["count", "nonNull", "sum", "mean", "min", "max"],
        )?;
        choice(&c["axisKind"], &["category", "number", "time"])?;
        if !c["sample"].is_boolean() || !c["parseStrings"].is_boolean() {
            return Err(error("invalid"));
        }
        let time = object(&c["timeOptions"], &["input", "naive", "bucket"], &[])?;
        choice(
            &time["input"],
            &[
                "iso",
                "seconds",
                "milliseconds",
                "microseconds",
                "nanoseconds",
            ],
        )?;
        choice(&time["naive"], &["utc", "reject"])?;
        choice(
            &time["bucket"],
            &[
                "instant", "second", "minute", "hour", "day", "week", "month", "quarter", "year",
            ],
        )?;
        let metric = object(
            &c["metricOptions"],
            &["target", "minimum", "maximum", "direction", "comparison"],
            &[],
        )?;
        let target = text(&metric["target"], 272)?;
        let min = text(&metric["minimum"], 272)?;
        let max = text(&metric["maximum"], 272)?;
        choice(&metric["direction"], &["higher", "lower"])?;
        choice(&metric["comparison"], &["previous", "first"])?;
        if mode == "chart" && chart == "kpi" && decimal(target).is_none() {
            return Err(error("target"));
        }
        if mode == "chart"
            && chart == "gauge"
            && !decimal(min)
                .zip(decimal(max))
                .is_some_and(|(a, b)| less(&a, &b))
        {
            return Err(error("range"));
        }
        let series = object(&c["series"], &["mode"], &["keys"])?;
        let selected = choice(&series["mode"], &["total", "all", "choose", "keys"])?;
        if selected == "keys" {
            let keys = series
                .get("keys")
                .and_then(Value::as_array)
                .ok_or_else(|| error("invalid"))?;
            if keys.is_empty() || keys.len() > 12 {
                return Err(error("invalid"));
            }
            let mut seen = HashSet::new();
            for k in keys {
                let k = text(k, 2048)?;
                if k.is_empty() || !seen.insert(k) {
                    return Err(error("invalid"));
                }
            }
        } else if series.contains_key("keys") {
            return Err(error("invalid"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use named_presets::PresetContent;
    use serde_json::json;
    fn config() -> Value {
        json!({"version":1,"mode":"chart","chart":"line","bindings":{"row":{"name":"day","dataType":"TEXT","ordinal":0},"measure":{"name":"amount","dataType":"DECIMAL","ordinal":1}},"aggregate":"mean","parseStrings":true,"axisKind":"time","timeOptions":{"input":"iso","naive":"utc","bucket":"day"},"metricOptions":{"target":"","minimum":"0","maximum":"100","direction":"higher","comparison":"previous"},"sample":true,"series":{"mode":"total"}})
    }
    fn request() -> SaveRequest {
        SaveRequest {
            id: None,
            revision: None,
            name: "Analysis".into(),
            content: Content { config: config() },
        }
    }
    #[test]
    fn exact_decimal_validation_handles_extremes_and_rejects_invalid_gauges() {
        for (min, max, valid) in [
            ("9223372036854775807", "9223372036854775808", true),
            ("1e-512", "2e-512", true),
            ("1e512", "2e512", true),
            ("-2e512", "-1e512", true),
            ("-0", "0", false),
            ("2", "1", false),
            ("0", "1e513", false),
            (".1", "1.", true),
            ("+", "2", false),
            ("1e", "2", false),
        ] {
            let mut content = Content { config: config() };
            content.config["chart"] = json!("gauge");
            content.config["bindings"]
                .as_object_mut()
                .unwrap()
                .remove("row");
            content.config["metricOptions"]["minimum"] = json!(min);
            content.config["metricOptions"]["maximum"] = json!(max);
            assert_eq!(content.validate().is_ok(), valid, "{min} to {max}");
        }
    }
    #[test]
    fn schema_is_bounded_and_rejects_source_payloads_without_leaking_values() {
        for (key, value) in [
            ("rows", json!([["secret"]])),
            ("result", json!({})),
            ("sql", json!("secret")),
            ("version", json!(2)),
            ("mode", json!("SQL")),
            ("sample", json!("true")),
            ("series", json!({"mode":"keys","keys":["a","a"]})),
        ] {
            let mut content = Content { config: config() };
            content.config[key] = value;
            let error = content.validate().unwrap_err().to_string();
            assert!(error.starts_with("preset_"));
            assert!(!error.contains("secret"));
        }
        let mut content = Content { config: config() };
        content.config["bindings"]["row"]["sql"] = json!("secret");
        assert!(content.validate().is_err());
        content.config = config();
        content.config["series"] = json!({"mode":"keys","keys":(0..12).map(|i| format!("{}{i}","中".repeat(2046))).collect::<Vec<_>>()});
        assert_eq!(content.validate().unwrap_err().to_string(), "preset_size");
    }
    #[test]
    fn restart_roundtrip_redacted_list_and_optimistic_mutations() {
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let mut r = request();
        r.content.config["series"] = json!({"mode":"keys","keys":["s:private-region"]});
        let first = store.save(r).unwrap();
        let reopened = PresetStore::new(dir.path());
        assert_eq!(
            reopened.get(&first.id).unwrap().content.config["series"]["keys"][0],
            "s:private-region"
        );
        assert!(!serde_json::to_string(&reopened.list().unwrap())
            .unwrap()
            .contains("private-region"));
        let renamed = store.rename(&first.id, &first.revision, "Renamed").unwrap();
        assert!(store.delete(&first.id, &first.revision).is_err());
        assert!(store.rename(&first.id, &first.revision, "Stale").is_err());
        let mut r = request();
        r.name = "renamed".into();
        assert!(store.save(r).is_err());
        let mut r = request();
        r.id = Some(renamed.id.clone());
        r.revision = Some(renamed.revision.clone());
        let replaced = store.save(r).unwrap();
        assert_eq!(replaced.content.config["series"]["mode"], "total");
        store.delete(&replaced.id, &replaced.revision).unwrap();
        assert!(PresetStore::new(dir.path()).list().unwrap().is_empty());
    }
    #[test]
    fn unknown_content_and_corrupt_storage_are_preserved() {
        assert!(serde_json::from_value::<SaveRequest>(
            json!({"id":null,"revision":null,"name":"bad","config":config(),"rows":["secret"]})
        )
        .is_err());
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let first = store.save(request()).unwrap();
        let original = std::fs::read(&store.path).unwrap();
        let mut corrupt: Value = serde_json::from_slice(&original).unwrap();
        corrupt["presets"][0]["config"]["sql"] = json!("secret");
        let corrupt = serde_json::to_vec(&corrupt).unwrap();
        std::fs::write(&store.path, &corrupt).unwrap();
        let reopened = PresetStore::new(dir.path());
        assert_eq!(reopened.list().err().unwrap().to_string(), "preset_corrupt");
        assert!(reopened.delete(&first.id, &first.revision).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), corrupt);
    }
    #[test]
    fn separate_instances_reload_and_cannot_overwrite_newer_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let a = PresetStore::new(dir.path());
        let b = PresetStore::new(dir.path());
        let first = a.save(request()).unwrap();
        assert_eq!(b.list().unwrap().len(), 1);
        let changed = a.rename(&first.id, &first.revision, "Changed").unwrap();
        assert_eq!(
            b.rename(&first.id, &first.revision, "Stale")
                .err()
                .unwrap()
                .to_string(),
            "preset_conflict"
        );
        let mut second = request();
        second.name = "Second".into();
        b.save(second).unwrap();
        assert_eq!(a.list().unwrap().len(), 2);
        assert_eq!(a.get(&first.id).unwrap().revision, changed.revision);
        let lock = {
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(a.path.with_extension("lock"))
                .unwrap();
            fs2::FileExt::lock_exclusive(&lock).unwrap();
            lock
        };
        assert_eq!(
            b.save(request()).err().unwrap().to_string(),
            "preset_conflict"
        );
        fs2::FileExt::unlock(&lock).unwrap();
        drop(lock);
        b.delete(&changed.id, &changed.revision).unwrap();
        assert_eq!(a.list().unwrap().len(), 1);
    }
    #[test]
    fn version_two_preserves_formula_definitions_and_rejects_unbound_payloads() {
        let mut c = config();
        c["version"] = json!(2);
        c["bindings"]["measure"] = json!({"calculated":0});
        c["calculations"] = json!({"inputs":[{"name":"amount","dataType":"DECIMAL","ordinal":1}],"fields":[{"id":"total","name":"Total","type":"number","expression":"[1]*2"},{"id":"label","name":"Label","type":"text","expression":"CONCAT(TEXT([2]), '[99]')"}]});
        Content { config: c.clone() }.validate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = PresetStore::new(dir.path());
        let mut request = request();
        request.content.config = c.clone();
        let saved = store.save(request).unwrap();
        assert_eq!(
            PresetStore::new(dir.path())
                .get(&saved.id)
                .unwrap()
                .content
                .config,
            c
        );
        for variant in 0..7 {
            let mut bad = c.clone();
            match variant {
                0 => bad["calculations"]["rows"] = json!(["secret"]),
                1 => bad["calculations"]["fields"][0]["expression"] = json!("[2]*2"),
                2 => bad["calculations"]["fields"][0]["type"] = json!("SQL"),
                3 => bad["bindings"]["measure"] = json!({"calculated":2}),
                4 => bad["calculations"]["fields"][1]["id"] = json!("total"),
                5 => bad["calculations"]["fields"][1]["name"] = json!("AMOUNT"),
                _ => bad["version"] = json!(1),
            }
            assert!(
                Content { config: bad }.validate().is_err(),
                "variant {variant}"
            );
        }
    }
}
