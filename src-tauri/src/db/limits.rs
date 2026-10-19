use crate::db::exec::{QueryResult, MAX_ROWS};
use std::io::Write;
pub const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct Count(usize);
impl Write for Count {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(data.len());
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub struct ResultBudget {
    rows: usize,
    bytes: usize,
}
impl Default for ResultBudget {
    fn default() -> Self {
        Self {
            rows: MAX_ROWS,
            bytes: MAX_RESULT_BYTES,
        }
    }
}
impl ResultBudget {
    pub fn retain(&mut self, result: &mut QueryResult) {
        let mut retained = 0;
        for row in &result.rows {
            let mut count = Count::default();
            if retained >= self.rows
                || serde_json::to_writer(&mut count, row).is_err()
                || count.0 > self.bytes
            {
                break;
            }
            self.bytes -= count.0;
            retained += 1;
        }
        self.rows -= retained;
        if retained < result.rows.len() {
            result.rows.truncate(retained);
            result.truncated = true;
        }
    }
}
