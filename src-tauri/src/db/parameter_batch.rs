//! Repeat a source script with typed parameter sets under one session lease.
use super::{
    exec::{QueryResult, RollbackState, ScriptOutcome},
    parameters::{self, QueryParameter},
    sessions::{self, EditorConnection},
    sql_script,
};
use crate::{
    error::{AppError, AppResult},
    model::DriverKind,
};
use serde::Serialize;
use std::time::Instant;

pub const MAX_SETS: usize = 100;

#[derive(Default, Serialize)]
pub struct Progress {
    pub sets: Vec<SetSummary>,
    pub failed_set: Option<usize>,
}

#[derive(Serialize)]
pub struct SetSummary {
    pub index: usize,
    pub first_result: usize,
    pub result_count: usize,
    pub statements: usize,
    pub affected: u64,
}

#[derive(Serialize)]
pub struct Outcome {
    #[serde(flatten)]
    pub outcome: ScriptOutcome,
    #[serde(flatten)]
    pub progress: Progress,
}

pub(crate) struct Execution<'a> {
    pub sets: &'a [Vec<QueryParameter>],
    pub progress: &'a mut Progress,
}

pub fn validate(source: &str, sets: &[Vec<QueryParameter>], driver: DriverKind) -> AppResult<()> {
    sql_script::validate_source(source)?;
    if sets.is_empty() || sets.len() > MAX_SETS {
        return Err(AppError::msg("a parameter batch requires 1 to 100 sets"));
    }
    if source.len().saturating_mul(sets.len()) > 32 * 1024 * 1024 {
        return Err(AppError::msg(
            "repeated SQL exceeds the 32 MiB batch work limit",
        ));
    }
    let mut bytes = 0usize;
    for (index, set) in sets.iter().enumerate() {
        parameters::validate_values(set, driver)
            .map_err(|error| AppError::msg(format!("parameter set {}: {error}", index + 1)))?;
        for parameter in set {
            bytes += parameter.value.as_ref().map_or(0, String::len);
        }
        if bytes > 8 * 1024 * 1024 {
            return Err(AppError::msg(
                "all batch parameter values together may contain at most 8 MiB",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn run(
    connection: &mut EditorConnection,
    source: &str,
    atomic: bool,
    in_transaction: &mut bool,
    manual_commit_mode: &mut bool,
    readonly: bool,
    batch: Execution<'_>,
) -> AppResult<ScriptOutcome> {
    let start = Instant::now();
    let initial = parameters::inspect_statement_syntax(connection, source).await?;
    let mut manages_transaction = false;
    let mut mysql_safe = true;
    let mut budget = sql_script::AnalysisBudget::default();
    let mut analyses = Vec::with_capacity(batch.sets.len());
    // Include every possible initial mode for later sets: an earlier set may
    // change it through SQL, a routine or transaction rollback.
    for (index, set) in batch.sets.iter().enumerate() {
        tokio::task::yield_now().await;
        let analysis =
            sql_script::analyze_with_budget(source, initial, Some(set), index > 0, &mut budget)
                .map_err(|error| AppError::msg(format!("parameter set {}: {error}", index + 1)))?;
        manages_transaction |= analysis.manages_transaction;
        mysql_safe &= analysis.mysql_rollback_safe;
        analyses.push(analysis);
    }
    let wrapped = atomic && !manages_transaction;
    if wrapped {
        sessions::one(connection, "BEGIN").await?;
        *in_transaction = true;
    }
    let mut results = Vec::new();
    let mut statements = 0;
    let mut total_affected = 0;
    let mut budget = super::limits::ResultBudget::default();
    for (index, set) in batch.sets.iter().enumerate() {
        let outcome = sessions::run_source(
            connection,
            source,
            in_transaction,
            manual_commit_mode,
            sessions::SourceExecution {
                atomic: false,
                parameters: set,
                readonly,
                preflight: Some(&analyses[index]),
            },
        )
        .await;
        match outcome {
            Ok(ScriptOutcome::Ok {
                results: mut current,
                statements: count,
                total_affected: affected,
                ..
            }) => {
                batch.progress.sets.push(SetSummary {
                    index,
                    first_result: results.len(),
                    result_count: current.len(),
                    statements: count,
                    affected,
                });
                for result in &mut current {
                    budget.retain(result);
                }
                results.extend(current);
                statements += count;
                total_affected += affected;
            }
            failed => {
                batch.progress.failed_set = Some(index);
                let (failed_index, count, error) = match failed {
                    Ok(ScriptOutcome::Failed {
                        failed_index,
                        statements,
                        error,
                        ..
                    }) => (failed_index, statements, error),
                    Err(error) => (0, 1, error.to_string()),
                    _ => unreachable!(),
                };
                let rollback = rollback(connection, wrapped, mysql_safe, in_transaction).await;
                return Ok(ScriptOutcome::Failed {
                    failed_index,
                    statements: statements + count,
                    error,
                    rollback,
                });
            }
        }
    }
    if wrapped {
        if let Err(error) = sessions::one(connection, "COMMIT").await {
            let rollback = rollback(connection, true, mysql_safe, in_transaction).await;
            return Ok(ScriptOutcome::Failed {
                failed_index: statements,
                statements,
                error: error.to_string(),
                rollback,
            });
        }
        *in_transaction = false;
    }
    let mut result = results.last().cloned().unwrap_or(QueryResult {
        columns: vec![],
        rows: vec![],
        rows_affected: None,
        elapsed_ms: 0,
        truncated: false,
    });
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(ScriptOutcome::Ok {
        result,
        results,
        total_affected,
        statements,
    })
}

async fn rollback(
    connection: &mut EditorConnection,
    wrapped: bool,
    mysql_safe: bool,
    in_transaction: &mut bool,
) -> RollbackState {
    if !wrapped {
        return RollbackState::SelfManaged;
    }
    if sessions::one(connection, "ROLLBACK").await.is_err() {
        return RollbackState::Partial;
    }
    *in_transaction = false;
    if matches!(connection, EditorConnection::Mysql(_)) && !mysql_safe {
        RollbackState::Partial
    } else {
        RollbackState::Complete
    }
}
