//! CLI entry point for the CodeGoblin native efficiency layer.
//!
//! Reads a single JSON request from stdin and writes a single JSON response to
//! stdout. This keeps integration runtime-agnostic: the TypeScript side spawns
//! the binary and pipes JSON, with a pure-TS fallback when the binary is absent.
//!
//! Requests:
//!   {"op":"scan","contents":["..."]}
//!     -> {"ok":true,"reasons":[null,"contains ..."]}
//!   {"op":"rank","query":"...","entries":[{"id":"1","content":"...","pinned":false}]}
//!     -> {"ok":true,"ranked":[{"id":"1","score":3.0}]}

use std::io::{Read, Write};

use codegoblin_native::{rank_entries, scan_content, Entry, Ranked};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Scan { contents: Vec<String> },
    Rank { query: String, entries: Vec<Entry> },
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Scan { ok: bool, reasons: Vec<Option<String>> },
    Rank { ok: bool, ranked: Vec<Ranked> },
    Error { ok: bool, message: String },
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        emit(&Response::Error { ok: false, message: "failed to read stdin".into() });
        return;
    }

    let response = match serde_json::from_str::<Request>(input.trim()) {
        Ok(Request::Scan { contents }) => Response::Scan {
            ok: true,
            reasons: contents.iter().map(|c| scan_content(c)).collect(),
        },
        Ok(Request::Rank { query, entries }) => Response::Rank {
            ok: true,
            ranked: rank_entries(&query, &entries),
        },
        Err(error) => Response::Error { ok: false, message: error.to_string() },
    };

    emit(&response);
}

fn emit(response: &Response) {
    if let Ok(serialized) = serde_json::to_string(response) {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(serialized.as_bytes());
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}
