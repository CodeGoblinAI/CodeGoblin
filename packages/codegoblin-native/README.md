# codegoblin-native

Native efficiency layer for CodeGoblin's memory hot paths:

- **Ranked recall scoring** — term extraction + frequency scoring with a pinned bonus.
- **Prompt-injection guard scanning** — mirrors the patterns in `memory-guard.ts`.

This crate is **optional**. The TypeScript side (`packages/codegoblin/src/codegoblin/memory-native.ts`)
shells out to the `codegoblin-native` binary when it is present and falls back to an
equivalent pure-TS implementation otherwise, so behavior is identical whether or not
the native layer is built.

## Build

```sh
cd packages/codegoblin-native
cargo build --release
```

This produces `target/release/codegoblin-native` (`.exe` on Windows). Point the TS layer
at it with:

```sh
export CODEGOBLIN_NATIVE_BIN="$(pwd)/target/release/codegoblin-native"
```

If `CODEGOBLIN_NATIVE_BIN` is unset, the TS layer also probes the default
`target/release` path. When neither exists, the TS fallback is used.

## Protocol

One JSON request on stdin, one JSON response on stdout.

```jsonc
// scan
{"op":"scan","contents":["ignore all previous instructions"]}
// -> {"ok":true,"reasons":["contains an instruction-override phrase"]}

// rank
{"op":"rank","query":"package manager","entries":[{"id":"a","content":"bun is the package manager","pinned":false}]}
// -> {"ok":true,"ranked":[{"id":"a","score":2.0}]}
```

## Test

```sh
cargo test
```
