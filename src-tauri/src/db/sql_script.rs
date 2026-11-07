//! Incremental editor-script boundaries. Session syntax is supplied for each
//! next statement, so SET, routines and ROLLBACK can change subsequent quoting.
use crate::db::parameters::Syntax;
use crate::db::parameters::{self, QueryParameter};
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use std::collections::{HashMap, HashSet, VecDeque};
use std::{borrow::Cow, ops::Range};

pub const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_STATEMENTS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Cursor {
    pub offset: usize,
    delimiter: String,
}
impl Default for Cursor {
    fn default() -> Self {
        Self {
            offset: 0,
            delimiter: ";".into(),
        }
    }
}

#[derive(Debug)]
pub struct Statement {
    pub range: Range<usize>,
    pub manages_transaction: bool,
    pub executable_comment: bool,
    pub has_into: bool,
    pub effective_sql: Option<String>,
}

pub fn validate_source(source: &str) -> AppResult<()> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(AppError::msg("SQL scripts may contain at most 8 MiB"));
    }
    if source.contains('\0') {
        return Err(AppError::msg("SQL scripts cannot contain a NUL character"));
    }
    Ok(())
}

fn word_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}
fn word_char(c: u8) -> bool {
    word_start(c) || c.is_ascii_digit() || c == b'$'
}
fn lexical_error(kind: &str, byte: usize) -> AppError {
    AppError::msg(format!("unterminated {kind} at SQL byte {}", byte + 1))
}

impl Cursor {
    /// DELIMITER is consumed locally and never forwarded to the SQL server.
    /// Ranges refer to the original source, preserving internal comments and line breaks.
    pub fn next(&mut self, source: &str, syntax: Syntax) -> AppResult<Option<Statement>> {
        let bytes = source.as_bytes();
        let mut start = self.offset;
        let mut i = start;
        let mut has_sql = false;
        let mut executable_comment = false;
        let mut replacements = Vec::new();
        let mut has_into = false;
        let mut words: Vec<String> = Vec::new();
        let mut previous_word = String::new();
        let mut trigger = false;
        let mut trigger_semicolon = false;
        let mut trigger_end = false;
        let mut routine = false;
        let mut atomic_depth = 0usize;
        let mut case_depth = 0usize;
        while i < bytes.len() {
            let c = bytes[i];
            if c.is_ascii_whitespace() {
                i += 1;
                continue;
            }
            // Delimiters take precedence over tokens outside quoted regions.
            if bytes[i..].starts_with(self.delimiter.as_bytes()) {
                let end = i;
                i += self.delimiter.len();
                if self.delimiter == ";" && (atomic_depth > 0 || trigger && !trigger_end) {
                    trigger_semicolon = trigger;
                    previous_word.clear();
                    continue;
                }
                self.offset = i;
                if has_sql {
                    return Ok(Some(statement(
                        source,
                        start..end,
                        &words,
                        executable_comment,
                        has_into,
                        &replacements,
                    )));
                }
                start = i;
                words.clear();
                previous_word.clear();
                continue;
            }
            if c == b'-'
                && bytes.get(i + 1) == Some(&b'-')
                && (syntax.driver != DriverKind::Mysql
                    || bytes
                        .get(i + 2)
                        .is_none_or(|c| c.is_ascii_whitespace() || c.is_ascii_control()))
                || c == b'#' && syntax.driver == DriverKind::Mysql
            {
                while i < bytes.len() && !matches!(bytes[i], b'\n' | b'\r') {
                    i += 1;
                }
                continue;
            }
            if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
                let begin = i;
                // Version comments carry SQL even when no ordinary token is
                // present; retain them as executable input for the server.
                let executable = syntax.driver == DriverKind::Mysql
                    && (bytes[i..].starts_with(b"/*!") || bytes[i..].starts_with(b"/*M!"));
                if executable {
                    if !has_sql {
                        start = i;
                    }
                    executable_comment = true;
                    has_sql = true;
                }
                let mut depth = 1usize;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i..].starts_with(b"/*") && syntax.driver == DriverKind::Postgres {
                        depth += 1;
                        i += 2;
                    } else if bytes[i..].starts_with(b"*/") {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                if depth != 0 {
                    return Err(lexical_error("block comment", begin));
                }
                if executable {
                    let maria = bytes[begin..].starts_with(b"/*M!");
                    let mut body = begin + if maria { 4 } else { 3 };
                    let digits = body;
                    while bytes.get(body).is_some_and(u8::is_ascii_digit) {
                        body += 1;
                    }
                    let minimum = source[digits..body].parse::<u32>().unwrap_or(0);
                    let active = syntax.mysql_version.is_none_or(|(version, is_maria)| {
                        (!maria || is_maria)
                            && version >= minimum
                            && !(is_maria && !maria && (50700..=99999).contains(&minimum))
                    });
                    replacements.push((begin..i, active.then_some(body..i - 2)));
                }
                continue;
            }
            if c == b'\''
                || c == b'"'
                || c == b'`' && syntax.driver != DriverKind::Postgres
                || c == b'[' && syntax.driver == DriverKind::Sqlite
            {
                if !has_sql {
                    start = i;
                }
                let begin = i;
                let end = if c == b'[' { b']' } else { c };
                let pg_escape = syntax.driver == DriverKind::Postgres
                    && c == b'\''
                    && i > 0
                    && matches!(bytes[i - 1], b'e' | b'E')
                    && (i == 1 || !word_char(bytes[i - 2]));
                let string = c == b'\''
                    || c == b'"' && syntax.driver == DriverKind::Mysql && !syntax.ansi_quotes;
                let escapes = string && (syntax.backslash_strings || pg_escape);
                i += 1;
                let mut closed = false;
                while i < bytes.len() {
                    if escapes && bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                    } else if bytes[i] == end {
                        i += 1;
                        if end != b']' && bytes.get(i) == Some(&end) {
                            i += 1;
                        } else {
                            closed = true;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                if !closed {
                    return Err(lexical_error("quoted token", begin));
                }
                has_sql = true;
                trigger_semicolon = false;
                trigger_end = false;
                previous_word.clear();
                continue;
            }
            if c == b'$'
                && syntax.driver == DriverKind::Postgres
                && (i == 0 || !word_char(bytes[i - 1]))
            {
                let mut end = i + 1;
                if bytes.get(end).is_some_and(|c| word_start(*c)) {
                    while bytes
                        .get(end)
                        .is_some_and(|c| word_start(*c) || c.is_ascii_digit())
                    {
                        end += 1;
                    }
                }
                if bytes.get(end) == Some(&b'$') {
                    if !has_sql {
                        start = i;
                    }
                    let tag = &source[i..=end];
                    let Some(close) = source[end + 1..].find(tag) else {
                        return Err(lexical_error("dollar quote", i));
                    };
                    i = end + 1 + close + tag.len();
                    has_sql = true;
                    previous_word.clear();
                    continue;
                }
            }
            if word_start(c) {
                let begin = i;
                i += 1;
                while i < bytes.len()
                    && word_char(bytes[i])
                    && !bytes[i..].starts_with(self.delimiter.as_bytes())
                {
                    i += 1;
                }
                let word = source[begin..i].to_ascii_uppercase();
                if syntax.driver == DriverKind::Mysql
                    && !has_sql
                    && word == "DELIMITER"
                    && source[..begin]
                        .rsplit(['\n', '\r'])
                        .next()
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                {
                    let line_end = source[i..]
                        .find(['\n', '\r'])
                        .map_or(source.len(), |n| i + n);
                    self.delimiter = parse_delimiter(&source[i..line_end])?;
                    i = line_end;
                    self.offset = i;
                    start = i;
                    continue;
                }
                if !has_sql {
                    start = begin;
                }
                has_into |= word == "INTO";
                if words.len() < 6 {
                    words.push(word.clone());
                }
                // SQLite completeness: a trigger terminates at ; END ;, not
                // at CASE ... END expressions inside one of its statements.
                let create = words.first().is_some_and(|w| w == "CREATE");
                if create
                    && syntax.driver == DriverKind::Sqlite
                    && word == "TRIGGER"
                    && (words.len() == 2
                        || words.len() == 3 && matches!(words[1].as_str(), "TEMP" | "TEMPORARY"))
                {
                    trigger = true;
                }
                if create
                    && syntax.driver == DriverKind::Postgres
                    && matches!(word.as_str(), "FUNCTION" | "PROCEDURE")
                    && (words.len() == 2
                        || words.len() == 4 && words[1] == "OR" && words[2] == "REPLACE")
                {
                    routine = true;
                }
                if routine && word == "ATOMIC" && previous_word == "BEGIN" {
                    atomic_depth += 1;
                } else if atomic_depth > 0 {
                    if word == "CASE" {
                        case_depth += 1;
                    } else if word == "END" {
                        if case_depth > 0 {
                            case_depth -= 1;
                        } else {
                            atomic_depth -= 1;
                        }
                    }
                }
                trigger_end = trigger && trigger_semicolon && word == "END";
                trigger_semicolon = false;
                previous_word = word;
                has_sql = true;
                continue;
            }
            if !has_sql {
                start = i;
            }
            has_sql = true;
            trigger_semicolon = false;
            trigger_end = false;
            previous_word.clear();
            i += 1;
        }
        self.offset = i;
        if atomic_depth > 0 || trigger && !trigger_end {
            return Err(lexical_error("compound SQL body", start));
        }
        Ok(has_sql.then(|| {
            statement(
                source,
                start..i,
                &words,
                executable_comment,
                has_into,
                &replacements,
            )
        }))
    }
}

fn statement(
    source: &str,
    range: Range<usize>,
    words: &[String],
    executable_comment: bool,
    has_into: bool,
    replacements: &[(Range<usize>, Option<Range<usize>>)],
) -> Statement {
    let effective_sql = (!replacements.is_empty()).then(|| {
        let mut effective = source.as_bytes()[range.clone()].to_vec();
        for (comment, body) in replacements {
            for offset in comment.clone() {
                if !body.as_ref().is_some_and(|body| body.contains(&offset))
                    && !matches!(effective[offset - range.start], b'\n' | b'\r')
                {
                    effective[offset - range.start] = b' ';
                }
            }
        }
        String::from_utf8(effective).expect("comment masks preserve UTF-8")
    });
    let first = effective_sql.as_ref().map_or_else(
        || words.first().cloned().unwrap_or_default(),
        |sql| crate::db::exec::first_keyword(sql),
    );
    // START without TRANSACTION is invalid SQL; treating it conservatively as
    // transaction control still preserves the server's own error.
    let manages_transaction = matches!(
        first.as_str(),
        "BEGIN" | "COMMIT" | "ROLLBACK" | "END" | "SAVEPOINT" | "RELEASE" | "START"
    ) || first == "SET" && {
        let sql = effective_sql
            .as_deref()
            .unwrap_or(&source[range.clone()])
            .to_ascii_uppercase();
        sql.contains("AUTOCOMMIT") || sql.contains("TRANSACTION")
    };
    Statement {
        range,
        manages_transaction,
        executable_comment,
        has_into,
        effective_sql,
    }
}

/// Remove conditional-comment wrappers using the connected server's version.
/// Byte offsets remain stable so parameter locations still refer to the source.
/// With no server version (offline inspection), include all conditional bodies
/// conservatively; execution always obtains the actual version first.
pub(crate) fn mysql_effective_sql(source: &str, syntax: Syntax) -> AppResult<Cow<'_, str>> {
    if syntax.driver != DriverKind::Mysql || !(source.contains("/*!") || source.contains("/*M!")) {
        return Ok(Cow::Borrowed(source));
    }
    let mut cursor = Cursor::default();
    let mut effective = None::<String>;
    while let Some(statement) = cursor.next(source, syntax)? {
        if let Some(sql) = statement.effective_sql {
            effective
                .get_or_insert_with(|| source.to_owned())
                .replace_range(statement.range, &sql);
        }
    }
    Ok(effective.map_or(Cow::Borrowed(source), Cow::Owned))
}

fn parse_delimiter(rest: &str) -> AppResult<String> {
    let rest = rest.trim();
    let (delimiter, tail) = if rest.starts_with(['\'', '"']) {
        let quote = rest.as_bytes()[0] as char;
        let end = rest[1..]
            .find(quote)
            .ok_or_else(|| AppError::msg("unterminated DELIMITER value"))?
            + 1;
        (&rest[1..end], rest[end + 1..].trim())
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        (&rest[..end], rest[end..].trim())
    };
    if delimiter.is_empty()
        || delimiter.len() > 32
        || delimiter.chars().any(|c| c.is_whitespace() || c == '\\')
        || !(tail.is_empty() || tail.starts_with('#') || tail.starts_with("-- "))
    {
        return Err(AppError::msg("DELIMITER needs one nonempty value, at most 32 bytes, without whitespace or backslashes"));
    }
    Ok(delimiter.to_owned())
}

pub fn split(source: &str, syntax: Syntax) -> AppResult<Vec<Statement>> {
    validate_source(source)?;
    let mut cursor = Cursor::default();
    let mut out = Vec::new();
    while let Some(statement) = cursor.next(source, syntax)? {
        if out.len() >= MAX_STATEMENTS {
            return Err(AppError::msg("scripts may contain at most 128 statements"));
        }
        out.push(statement);
    }
    Ok(out)
}

pub fn ensure_single(source: &str, syntax: Syntax) -> AppResult<()> {
    if split(source, syntax)?.len() != 1 {
        return Err(AppError::msg(
            "each script item must contain one SQL statement",
        ));
    }
    Ok(())
}

/// MySQL's READ ONLY transaction does not guard file output. Check actual
/// session quoting before forwarding SQL; executable comments can hide both
/// output clauses and transaction controls and are deliberately rejected.
pub(crate) fn check_mysql_readonly(source: &str, syntax: Syntax) -> AppResult<()> {
    let statements = split(source, syntax)?;
    if statements.len() != 1
        || statements[0].executable_comment
        || statements[0].has_into
        || !crate::db::exec::is_readonly(source)
    {
        return Err(AppError::msg("connection is read-only — expected one read-only statement without executable comments or INTO"));
    }
    Ok(())
}

#[derive(Debug)]
pub struct Analysis {
    pub names: Vec<String>,
    pub max_statements: usize,
    pub manages_transaction: bool,
    pub mysql_rollback_safe: bool,
}

/// Explore future quoting modes without executing SQL. This discovers all
/// potentially required parameters before any write, including when changing
/// quoting rules changes statement boundaries themselves. The execution path
/// still advances one boundary at a time with the actual session mode.
pub fn analyze(
    source: &str,
    initial: Syntax,
    values: Option<&[QueryParameter]>,
) -> AppResult<Analysis> {
    analyze_with_modes(source, initial, values, false)
}

pub(crate) fn analyze_with_modes(
    source: &str,
    initial: Syntax,
    values: Option<&[QueryParameter]>,
    future_start: bool,
) -> AppResult<Analysis> {
    analyze_with_budget(
        source,
        initial,
        values,
        future_start,
        &mut AnalysisBudget::default(),
    )
}

/// Shared across all sets in a batch, including alternate quoting paths.
pub(crate) struct AnalysisBudget {
    remaining: usize,
}
impl Default for AnalysisBudget {
    fn default() -> Self {
        Self {
            remaining: 32 * MAX_SOURCE_BYTES,
        }
    }
}

pub(crate) fn analyze_with_budget(
    source: &str,
    initial: Syntax,
    values: Option<&[QueryParameter]>,
    future_start: bool,
    budget: &mut AnalysisBudget,
) -> AppResult<Analysis> {
    validate_source(source)?;
    let mut variants = vec![initial];
    if initial.driver != DriverKind::Sqlite {
        for backslash_strings in [false, true] {
            for ansi_quotes in [false, true] {
                if initial.driver == DriverKind::Postgres && ansi_quotes {
                    continue;
                }
                if backslash_strings != initial.backslash_strings
                    || ansi_quotes != initial.ansi_quotes
                {
                    variants.push(Syntax {
                        backslash_strings,
                        ansi_quotes,
                        ..initial
                    });
                }
            }
        }
    }
    let mut queue = VecDeque::from([(Cursor::default(), 0usize)]);
    let mut visited = HashMap::<Cursor, usize>::new();
    let mut analysis = Analysis {
        names: Vec::new(),
        max_statements: 0,
        manages_transaction: false,
        mysql_rollback_safe: true,
    };
    let mut names = HashSet::new();
    let mut terminal = false;
    let mut last_error = None;
    while let Some((cursor, count)) = queue.pop_front() {
        if visited.get(&cursor).is_some_and(|prior| *prior >= count) {
            continue;
        }
        if visited.len() >= 1024 {
            return Err(AppError::msg(
                "SQL quoting is too ambiguous; split this script into smaller runs",
            ));
        }
        visited.insert(cursor.clone(), count);
        for syntax in if count == 0 && !future_start {
            &variants[..1]
        } else {
            &variants[..]
        } {
            let mut next = cursor.clone();
            let parsed = next.next(source, *syntax);
            // On a lexical failure the scanner can have inspected the full tail.
            let scanned = if parsed.is_ok() {
                next.offset - cursor.offset
            } else {
                source.len() - cursor.offset
            };
            budget.remaining = budget.remaining.checked_sub(scanned).ok_or_else(|| AppError::msg("SQL quoting analysis exceeds its work budget; split this script into smaller runs"))?;
            match parsed {
                Ok(Some(statement)) => {
                    if count >= MAX_STATEMENTS {
                        return Err(AppError::msg("scripts may contain at most 128 statements"));
                    }
                    let sql = source[statement.range].to_owned();
                    if initial.driver == DriverKind::Mysql {
                        // A custom-delimiter item can contain internal SQL.
                        // Do not promise a full rollback for an opaque compound
                        // item or conditional comment, even when its first word is DML.
                        analysis.mysql_rollback_safe &= !statement.executable_comment
                            && !sql.contains(';')
                            && crate::db::exec::mysql_keeps_transaction(&sql);
                    }
                    let sqls = [sql];
                    let required = parameters::parameter_names(&sqls, *syntax)?;
                    if let Some(values) = values {
                        parameters::validate_bindings(&sqls, *syntax, values)?;
                    }
                    for name in required {
                        if names.insert(name.clone()) {
                            analysis.names.push(name);
                        }
                    }
                    if names.len() > 128 {
                        return Err(AppError::msg(
                            "scripts may contain at most 128 named parameters",
                        ));
                    }
                    analysis.manages_transaction |= statement.manages_transaction;
                    queue.push_back((next, count + 1));
                }
                Ok(None) => {
                    terminal = true;
                    analysis.max_statements = analysis.max_statements.max(count);
                }
                Err(error) => last_error = Some(error),
            }
        }
    }
    if !terminal {
        return Err(last_error.unwrap_or_else(|| AppError::msg("could not parse SQL script")));
    }
    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alternate_modes_and_parameter_sets_share_one_analysis_budget() {
        let source = "SELECT :value";
        let syntax = Syntax::default_for(DriverKind::Mysql);
        let mut budget = AnalysisBudget {
            remaining: source.len() * 4,
        };
        analyze_with_budget(source, syntax, None, false, &mut budget).unwrap();
        let error = analyze_with_budget(source, syntax, None, true, &mut budget).unwrap_err();
        assert!(error.to_string().contains("work budget"));
        // A separate call with a fresh budget can explore all initial modes.
        assert!(analyze_with_modes(source, syntax, None, true).is_ok());
    }
    fn parts(source: &str, syntax: Syntax) -> Vec<&str> {
        split(source, syntax)
            .unwrap()
            .into_iter()
            .map(|statement| source[statement.range].trim())
            .collect()
    }
    #[test]
    fn sqlite_quotes_comments_and_trigger_body() {
        let s = Syntax::default_for(DriverKind::Sqlite);
        assert_eq!(
            parts("SELECT 'a\\'; SELECT [a;b], `c;d`, 'it''s;ok'; -- tail", s).len(),
            2
        );
        let sql = "CREATE TEMP TRIGGER tr AFTER INSERT ON t WHEN new.x > 0 BEGIN INSERT INTO log VALUES(CASE WHEN new.x=1 THEN ';END;' ELSE 'x' END); UPDATE t SET x=2; END; SELECT 3;";
        let statements = parts(sql, s);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].ends_with("END"));
        assert_eq!(statements[1], "SELECT 3");
        assert!(split("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;", s).is_err());
    }
    #[test]
    fn postgres_dollar_escape_identifiers_and_nested_comments() {
        let s = Syntax::default_for(DriverKind::Postgres);
        assert_eq!(parts("/* outer /* ; */ tail */ SELECT $标签$';$标签$; SELECT E'a\\';b'; SELECT foo$tag$, 'a\\'; SELECT 4", s).len(), 4);
        assert_eq!(parts("SELECT \"a\\\"; SELECT 2", s).len(), 2);
        let sql = "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; SELECT 2; END; SELECT f();";
        assert_eq!(parts(sql, s).len(), 2);
        assert_eq!(parts("BEGIN; SELECT 1; END", s).len(), 3);
        assert!(split("SELECT $标签$missing", s).is_err());
    }
    #[test]
    fn mysql_delimiter_is_local_and_quotes_follow_modes() {
        let s = Syntax::default_for(DriverKind::Mysql);
        let sql = "-- setup\nDELIMITER $$\nCREATE PROCEDURE f() BEGIN SELECT 'x;$$'; SELECT 2; END$$\nDELIMITER ;\nCALL f(); # tail\nSELECT 3--2;";
        let statements = parts(sql, s);
        assert_eq!(statements.len(), 3);
        assert!(statements[0].starts_with("CREATE PROCEDURE"));
        assert!(statements[0].ends_with("END"));
        assert_eq!(statements[1], "CALL f()");
        assert!(statements[2].ends_with("SELECT 3--2"));
        assert_eq!(parts("/*!40101 SET @x=1 */; SELECT 2", s).len(), 2);
        assert!(split("DELIMITER\nSELECT 1", s).is_err());
        let no_escape = Syntax::from_setting(DriverKind::Mysql, "ANSI_QUOTES,NO_BACKSLASH_ESCAPES");
        assert_eq!(
            parts("SELECT 'a\\'; SELECT \"b\\\"; SELECT 3", no_escape).len(),
            3
        );
    }
    #[test]
    fn cursor_accepts_new_session_mode_after_each_statement() {
        let source = "SET standard_conforming_strings=off; SELECT 'a\\';b'; SET standard_conforming_strings=on; SELECT 'a\\'; SELECT 42;";
        let on = Syntax::default_for(DriverKind::Postgres);
        let off = Syntax::from_setting(DriverKind::Postgres, "off");
        let mut cursor = Cursor::default();
        let mut count = 0;
        for syntax in [on, off, off, on, on] {
            assert!(cursor.next(source, syntax).unwrap().is_some());
            count += 1;
        }
        assert_eq!(count, 5);
        assert!(cursor.next(source, on).unwrap().is_none());
    }
    #[test]
    fn readonly_mysql_checks_real_tokens_in_each_mode() {
        for mode in [
            "",
            "ANSI_QUOTES",
            "NO_BACKSLASH_ESCAPES",
            "ANSI_QUOTES,NO_BACKSLASH_ESCAPES",
        ] {
            let syntax = Syntax::from_setting(DriverKind::Mysql, mode);
            for sql in [
                "SELECT 1 /*!80000 INTO OUTFILE '/unused' */",
                "SELECT 1 /*M! INTO OUTFILE '/unused' */",
                "/*!80000 SELECT 1 */",
                "SELECT 1 INTO OUTFILE '/unused'",
                "SELECT 1; SELECT 2",
            ] {
                assert!(check_mysql_readonly(sql, syntax).is_err(), "{mode}: {sql}");
            }
            for sql in [
                "SELECT '/*! INTO OUTFILE */'",
                "SELECT `/*M! INTO */` FROM t",
                "SELECT 1 /* INTO OUTFILE */",
                "SELECT 1 # /*! INTO */\n",
                "SELECT 1--2",
            ] {
                assert!(check_mysql_readonly(sql, syntax).is_ok(), "{mode}: {sql}");
            }
        }
        let no_escape = Syntax::from_setting(DriverKind::Mysql, "NO_BACKSLASH_ESCAPES");
        assert!(check_mysql_readonly(
            r"SELECT 'x\' /*!80000 INTO OUTFILE '/unused' */ -- '",
            no_escape
        )
        .is_err());
        assert!(
            check_mysql_readonly(r"SELECT 'x\' INTO OUTFILE '/unused' -- '", no_escape).is_err()
        );
    }

    #[test]
    fn malformed_and_resource_limits_are_explicit() {
        let s = Syntax::default_for(DriverKind::Sqlite);
        for sql in ["SELECT 'x", "SELECT [x", "SELECT 1 /* x", "SELECT 1\0;"] {
            assert!(split(sql, s).is_err(), "{sql:?}");
        }
        assert!(split(&"SELECT 1;".repeat(129), s).is_err());
        assert!(split(&" ".repeat(MAX_SOURCE_BYTES + 1), s).is_err());
        assert!(parts("-- only\n /* comments */ ; ;", s).is_empty());
    }
}
