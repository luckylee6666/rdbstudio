use crate::error::AppResult;
use keyring::Entry;

const SERVICE: &str = "rdbstudio";

fn entry(id: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, id)
}

pub fn store_password(id: &str, password: &str) -> AppResult<()> {
    entry(id)?.set_password(password)?;
    Ok(())
}

pub fn read_password(id: &str) -> AppResult<Option<String>> {
    match entry(id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_password(id: &str) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
