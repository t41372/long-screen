//! The row store: every row a run persists, by key, in key order — the native stand-in for the page's IndexedDB
//! namespace `run/<id>/` (plus the `project/<id>` row).
//!
//! Rows live in memory. Encoded tile images can move to a spill directory once they take more than the store's
//! budget, so a long recording's print does not have to fit in RAM twice (decoded in the tile cache and encoded
//! here); they are read back from there when a pass or the output writer asks for them.

use crate::value::{Js, Obj};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

/// Where a blob's bytes are.
#[derive(Clone, Debug)]
enum Spilled {
    File(PathBuf),
}

/// Rows by key, iterated in key order.
pub struct Store {
    rows: BTreeMap<String, Js>,
    /// Bytes of blobs held in memory, and the budget past which new blobs go to `spill`.
    blob_bytes: usize,
    budget: Option<usize>,
    spill: Option<PathBuf>,
    spilled: BTreeMap<String, Spilled>,
    spill_count: u64,
}

impl Store {
    /// A store that keeps everything in memory.
    pub fn in_memory() -> Store {
        Store {
            rows: BTreeMap::new(),
            blob_bytes: 0,
            budget: None,
            spill: None,
            spilled: BTreeMap::new(),
            spill_count: 0,
        }
    }

    /// A store that writes blobs into `dir` once those in memory exceed `budget` bytes.
    pub fn spilling(dir: PathBuf, budget: usize) -> io::Result<Store> {
        fs::create_dir_all(&dir)?;
        let mut store = Store::in_memory();
        store.budget = Some(budget);
        store.spill = Some(dir);
        Ok(store)
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// The row under `key`, with any spilled blob read back.
    pub fn get(&self, key: &str) -> Option<Js> {
        let row = self.rows.get(key)?;
        if let Some(Spilled::File(path)) = self.spilled.get(key) {
            let mut row = row.clone();
            if let Js::Obj(o) = &mut row {
                if let Some(Js::Blob(kind, _)) = o.get("blob").cloned() {
                    let bytes = fs::read(path).unwrap_or_default();
                    o.set("blob", Js::Blob(kind, Arc::new(bytes)));
                }
            }
            return Some(row);
        }
        Some(row.clone())
    }

    /// A reference to the row as stored (a spilled blob reads as empty).
    pub fn peek(&self, key: &str) -> Option<&Js> {
        self.rows.get(key)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.rows.contains_key(key)
    }

    pub fn put(&mut self, key: &str, value: Js) {
        self.forget_blob(key);
        let value = self.maybe_spill(key, value);
        self.rows.insert(key.to_string(), value);
    }

    pub fn delete(&mut self, key: &str) {
        self.forget_blob(key);
        self.rows.remove(key);
    }

    /// Keys under `prefix`, in key order.
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        self.rows
            .range(prefix.to_string()..)
            .take_while(|(k, _)| k.starts_with(prefix))
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub fn delete_prefix(&mut self, prefix: &str) {
        for key in self.keys(prefix) {
            self.delete(&key);
        }
    }

    /// Every row, in key order (spilled blobs read as empty; see [`Store::get`]).
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Js)> {
        self.rows.iter()
    }

    fn blob_len(value: &Js) -> usize {
        match value {
            Js::Obj(o) => match o.get("blob") {
                Some(Js::Blob(_, b)) => b.len(),
                _ => 0,
            },
            _ => 0,
        }
    }

    fn forget_blob(&mut self, key: &str) {
        if let Some(Spilled::File(path)) = self.spilled.remove(key) {
            let _ = fs::remove_file(path);
        } else if let Some(old) = self.rows.get(key) {
            self.blob_bytes -= Self::blob_len(old);
        }
    }

    fn maybe_spill(&mut self, key: &str, value: Js) -> Js {
        let len = Self::blob_len(&value);
        if len == 0 {
            return value;
        }
        let (Some(budget), Some(dir)) = (self.budget, &self.spill) else {
            self.blob_bytes += len;
            return value;
        };
        if self.blob_bytes + len <= budget {
            self.blob_bytes += len;
            return value;
        }
        self.spill_count += 1;
        let path = dir.join(format!("{}.bin", self.spill_count));
        let Js::Obj(mut o) = value else {
            unreachable!()
        };
        let Some(Js::Blob(kind, bytes)) = o.get("blob").cloned() else {
            unreachable!()
        };
        if fs::write(&path, bytes.as_slice()).is_err() {
            // The spill directory failed: keep the blob in memory rather than lose it.
            self.blob_bytes += len;
            return Js::Obj(o);
        }
        o.set("blob", Js::Blob(kind, Arc::new(Vec::new())));
        self.spilled.insert(key.to_string(), Spilled::File(path));
        Js::Obj(o)
    }

    /// Blobs held in memory, in bytes.
    pub fn blob_bytes(&self) -> usize {
        self.blob_bytes
    }

    /// Rows whose blob lives in the spill directory.
    pub fn spilled(&self) -> usize {
        self.spilled.len()
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        for (_, Spilled::File(path)) in std::mem::take(&mut self.spilled) {
            let _ = fs::remove_file(path);
        }
    }
}

/// An object row's field, for readers that take a stored row apart.
pub fn obj(value: &Js) -> Option<&Obj> {
    value.as_obj()
}
