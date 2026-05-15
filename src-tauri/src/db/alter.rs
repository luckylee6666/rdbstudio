use crate::db::data::quote_ident;
use crate::db::design::{self, ColumnDetail};
use crate::db::pool::DbPool;
use crate::error::{AppError, AppResult};
use crate::model::DriverKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnEdit {
    /// None = newly added column
    #[serde(default)]
    pub original_name: Option<String>,
    pub name: String,
    pub data_type: String,
    #[serde(default = "default_true")]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct DesignerChange {
    pub columns: Vec<ColumnEdit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlterPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

pub async fn generate_alter(
    pool: &DbPool,
    schema: Option<&str>,
    table: &str,
    change: &DesignerChange,
) -> AppResult<AlterPlan> {
    let driver = pool.driver();
    let current = design::describe(pool, schema, table).await?;
    let qualified = match schema {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(driver, s),
            quote_ident(driver, table)
        ),
        _ => quote_ident(driver, table),
    };

    let mut statements: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Determine kept/renamed/modified/added
    let mut kept_originals: Vec<String> = Vec::new();
    for edit in &change.columns {
        match &edit.original_name {
            None => {
                statements.push(add_column(driver, &qualified, edit));
            }
            Some(orig) => {
                kept_originals.push(orig.clone());
                let cur = current.columns.iter().find(|c| &c.name == orig);
                if let Some(cur_col) = cur {
                    // rename?
                    if orig != &edit.name {
                        statements.push(rename_column(driver, &qualified, orig, &edit.name));
                    }
                    // modify type/nullable/default
                    let effective_name = &edit.name;
                    if driver == DriverKind::Sqlite {
                        if needs_type_change(cur_col, edit)
                            || cur_col.nullable != edit.nullable
                            || default_changed(cur_col, edit)
                        {
                            warnings.push(format!(
                                "SQLite doesn't support changing type/nullable/default of '{}' via ALTER. Use the SQL editor with a table rebuild.",
                                edit.name
                            ));
                        }
                    } else if driver == DriverKind::Mysql {
                        if needs_type_change(cur_col, edit)
                            || cur_col.nullable != edit.nullable
                            || default_changed(cur_col, edit)
                        {
                            statements.push(mysql_modify(&qualified, effective_name, edit));
                        }
                    } else {
                        // Postgres
                        if needs_type_change(cur_col, edit) {
                            statements.push(format!(
                                "ALTER TABLE {} ALTER COLUMN {} TYPE {}",
                                qualified,
                                quote_ident(driver, effective_name),
                                edit.data_type
                            ));
                        }
                        if cur_col.nullable != edit.nullable {
                            let verb = if edit.nullable { "DROP" } else { "SET" };
                            statements.push(format!(
                                "ALTER TABLE {} ALTER COLUMN {} {} NOT NULL",
                                qualified,
                                quote_ident(driver, effective_name),
                                verb
                            ));
                        }
                        if default_changed(cur_col, edit) {
                            match &edit.default {
                                Some(d) if !d.is_empty() => {
                                    statements.push(format!(
                                        "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {}",
                                        qualified,
                                        quote_ident(driver, effective_name),
                                        d
                                    ));
                                }
                                _ => {
                                    statements.push(format!(
                                        "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT",
                                        qualified,
                                        quote_ident(driver, effective_name)
                                    ));
                                }
                            }
                        }
                    }
                } else {
                    warnings.push(format!(
                        "original column '{}' no longer exists; skipping",
                        orig
                    ));
                }
            }
        }
    }

    // Dropped columns = present currently but not referenced in edits
    for cur_col in &current.columns {
        if !kept_originals.contains(&cur_col.name) {
            statements.push(format!(
                "ALTER TABLE {} DROP COLUMN {}",
                qualified,
                quote_ident(driver, &cur_col.name)
            ));
        }
    }

    Ok(AlterPlan {
        statements,
        warnings,
    })
}

fn add_column(driver: DriverKind, qualified: &str, c: &ColumnEdit) -> String {
    let mut s = format!(
        "ALTER TABLE {} ADD COLUMN {} {}",
        qualified,
        quote_ident(driver, &c.name),
        c.data_type
    );
    if !c.nullable {
        s.push_str(" NOT NULL");
    }
    if let Some(d) = &c.default {
        if !d.is_empty() {
            s.push_str(&format!(" DEFAULT {}", d));
        }
    }
    s
}

fn rename_column(driver: DriverKind, qualified: &str, from: &str, to: &str) -> String {
    format!(
        "ALTER TABLE {} RENAME COLUMN {} TO {}",
        qualified,
        quote_ident(driver, from),
        quote_ident(driver, to)
    )
}

fn mysql_modify(qualified: &str, name: &str, c: &ColumnEdit) -> String {
    let mut s = format!(
        "ALTER TABLE {} MODIFY COLUMN {} {}",
        qualified,
        quote_ident(DriverKind::Mysql, name),
        c.data_type
    );
    if !c.nullable {
        s.push_str(" NOT NULL");
    } else {
        s.push_str(" NULL");
    }
    if let Some(d) = &c.default {
        if !d.is_empty() {
            s.push_str(&format!(" DEFAULT {}", d));
        }
    }
    s
}

fn needs_type_change(current: &ColumnDetail, edit: &ColumnEdit) -> bool {
    current.data_type.to_lowercase().trim() != edit.data_type.to_lowercase().trim()
}

fn default_changed(current: &ColumnDetail, edit: &ColumnEdit) -> bool {
    let a = current.default.as_deref().unwrap_or("").trim();
    let b = edit.default.as_deref().unwrap_or("").trim();
    a != b
}

pub async fn apply_statements(
    pool: &DbPool,
    statements: &[String],
) -> AppResult<Vec<String>> {
    let mut applied = Vec::new();
    match pool {
        DbPool::Redis(_) => return crate::db::redis_ops::unsupported("Apply ALTER"),
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            for s in statements {
                sqlx::query(s)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| AppError::msg(format!("{}: {}", s, e)))?;
                applied.push(s.clone());
            }
            tx.commit().await?;
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            for s in statements {
                sqlx::query(s)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| AppError::msg(format!("{}: {}", s, e)))?;
                applied.push(s.clone());
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            // MySQL DDL is implicitly committed; run one at a time.
            for s in statements {
                sqlx::query(s)
                    .execute(p)
                    .await
                    .map_err(|e| AppError::msg(format!("{}: {}", s, e)))?;
                applied.push(s.clone());
            }
        }
    }
    Ok(applied)
}
