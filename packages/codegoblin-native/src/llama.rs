//! Launches and supervises the bundled llama.cpp server — the CodeGoblin local
//! runtime backend.
//!
//! CodeGoblin ships/manages a prebuilt `llama-server` rather than embedding
//! llama.cpp, so the heavy CUDA/C++ build stays out of the default path. This
//! subcommand resolves the engine + model and spawns the server with GPU
//! offload; the existing `codegoblin` provider then talks to it on :8787/v1.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub struct LlamaArgs {
    pub model: String,
    pub engine: Option<String>,
    pub host: String,
    pub port: u16,
    pub ngl: u32,
    pub ctx: u32,
    pub passthrough: Vec<String>,
}

impl Default for LlamaArgs {
    fn default() -> Self {
        Self {
            model: String::new(),
            engine: None,
            host: "127.0.0.1".to_string(),
            port: 8787,
            ngl: 99,
            ctx: 4096,
            passthrough: Vec::new(),
        }
    }
}

pub fn parse_args<I: Iterator<Item = String>>(mut args: I) -> Result<LlamaArgs, String> {
    let mut out = LlamaArgs::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" | "-m" => out.model = args.next().ok_or("--model requires a value")?,
            "--engine" => out.engine = Some(args.next().ok_or("--engine requires a value")?),
            "--host" => out.host = args.next().ok_or("--host requires a value")?,
            "--port" => {
                out.port = args.next().ok_or("--port requires a value")?.parse().map_err(|_| "invalid --port")?
            }
            "--ngl" => {
                out.ngl = args.next().ok_or("--ngl requires a value")?.parse().map_err(|_| "invalid --ngl")?
            }
            "--ctx" | "-c" => {
                out.ctx = args.next().ok_or("--ctx requires a value")?.parse().map_err(|_| "invalid --ctx")?
            }
            "--" => {
                out.passthrough.extend(args.by_ref());
                break;
            }
            other => return Err(format!("unknown llama arg: {other}")),
        }
    }
    if out.model.is_empty() {
        return Err("`llama` requires --model <path-or-name.gguf>".to_string());
    }
    Ok(out)
}

fn engine_filename() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Resolve the llama-server engine binary: explicit flag, then
/// `CODEGOBLIN_LLAMA_SERVER`, then a sibling `engine/` dir next to this binary,
/// then `CODEGOBLIN_RUNTIME_DIR/engine`.
pub fn resolve_engine(
    explicit: Option<&str>,
    env_get: impl Fn(&str) -> Option<String>,
    exe_dir: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(e) = explicit {
        return Some(PathBuf::from(e));
    }
    if let Some(e) = env_get("CODEGOBLIN_LLAMA_SERVER") {
        return Some(PathBuf::from(e));
    }
    let name = engine_filename();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("engine").join(name));
        candidates.push(dir.join(name));
    }
    if let Some(rt) = env_get("CODEGOBLIN_RUNTIME_DIR") {
        candidates.push(Path::new(&rt).join("engine").join(name));
    }
    candidates.into_iter().find(|p| exists(p))
}

/// Resolve a model argument: an existing file path is used directly; otherwise
/// it is treated as a model name resolved against the models directory.
pub fn resolve_model(
    model: &str,
    env_get: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    let direct = Path::new(model);
    if exists(direct) {
        return direct.to_path_buf();
    }
    let filename = if model.ends_with(".gguf") {
        model.to_string()
    } else {
        format!("{model}.gguf")
    };
    let models_dir = env_get("CODEGOBLIN_MODELS_DIR")
        .or_else(|| env_get("CODEGOBLIN_RUNTIME_DIR").map(|rt| format!("{rt}/models")));
    if let Some(dir) = models_dir {
        let candidate = Path::new(&dir).join(&filename);
        if exists(&candidate) {
            return candidate;
        }
    }
    direct.to_path_buf()
}

/// Build the `llama-server` argv (pure, testable).
pub fn build_command(engine: &Path, model: &Path, args: &LlamaArgs) -> Vec<String> {
    let mut argv = vec![
        engine.to_string_lossy().to_string(),
        "-m".to_string(),
        model.to_string_lossy().to_string(),
        "--host".to_string(),
        args.host.clone(),
        "--port".to_string(),
        args.port.to_string(),
        "-ngl".to_string(),
        args.ngl.to_string(),
        "-c".to_string(),
        args.ctx.to_string(),
    ];
    argv.extend(args.passthrough.iter().cloned());
    argv
}

pub fn run(args: LlamaArgs) -> Result<(), String> {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let env_get = |key: &str| std::env::var(key).ok();
    let exists = |p: &Path| p.exists();

    let engine = resolve_engine(args.engine.as_deref(), env_get, exe_dir, exists).ok_or_else(|| {
        format!(
            "llama.cpp engine ({}) not found. Pass --engine, set CODEGOBLIN_LLAMA_SERVER, or run `codegoblin runtime install`.",
            engine_filename()
        )
    })?;
    if !engine.exists() {
        return Err(format!("llama.cpp engine not found at {}", engine.display()));
    }
    let model = resolve_model(&args.model, env_get, exists);

    let argv = build_command(&engine, &model, &args);
    eprintln!(
        "codegoblin-native llama: serving {} on {}:{} (ngl {}, ctx {})",
        model.display(),
        args.host,
        args.port,
        args.ngl,
        args.ctx
    );
    let status = Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .map_err(|err| format!("failed to launch llama.cpp engine: {err}"))?;
    if !status.success() {
        return Err(format!("llama.cpp engine exited with {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_defaults() {
        let parsed = parse_args(args(&["--model", "gemma.gguf"]).into_iter()).unwrap();
        assert_eq!(parsed.model, "gemma.gguf");
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, 8787);
        assert_eq!(parsed.ngl, 99);
        assert_eq!(parsed.ctx, 4096);
    }

    #[test]
    fn parses_overrides_and_passthrough() {
        let parsed = parse_args(
            args(&["-m", "q.gguf", "--port", "9000", "--ngl", "20", "--", "--flash-attn"]).into_iter(),
        )
        .unwrap();
        assert_eq!(parsed.port, 9000);
        assert_eq!(parsed.ngl, 20);
        assert_eq!(parsed.passthrough, vec!["--flash-attn".to_string()]);
    }

    #[test]
    fn requires_model() {
        assert!(parse_args(args(&["--port", "9000"]).into_iter()).is_err());
    }

    #[test]
    fn explicit_engine_wins() {
        let got = resolve_engine(Some("C:/x/llama-server.exe"), |_| None, None, |_| false);
        assert_eq!(got, Some(PathBuf::from("C:/x/llama-server.exe")));
    }

    #[test]
    fn engine_from_env_then_sibling() {
        let from_env = resolve_engine(None, |k| (k == "CODEGOBLIN_LLAMA_SERVER").then(|| "/e/ls".to_string()), None, |_| false);
        assert_eq!(from_env, Some(PathBuf::from("/e/ls")));

        let exe_dir = Path::new("/app/bin");
        let from_sibling = resolve_engine(None, |_| None, Some(exe_dir), |p| p.ends_with(Path::new("engine").join(engine_filename())));
        assert_eq!(from_sibling, Some(exe_dir.join("engine").join(engine_filename())));
    }

    #[test]
    fn engine_not_found_is_none() {
        assert_eq!(resolve_engine(None, |_| None, None, |_| false), None);
    }

    #[test]
    fn model_name_resolves_against_models_dir() {
        let got = resolve_model(
            "gemma-3n-E2B",
            |k| (k == "CODEGOBLIN_MODELS_DIR").then(|| "/models".to_string()),
            |p| p == Path::new("/models/gemma-3n-E2B.gguf"),
        );
        assert_eq!(got, PathBuf::from("/models/gemma-3n-E2B.gguf"));
    }

    #[test]
    fn builds_expected_argv() {
        let mut a = LlamaArgs::default();
        a.port = 8787;
        let argv = build_command(Path::new("/e/llama-server"), Path::new("/m/x.gguf"), &a);
        assert_eq!(argv[0], "/e/llama-server");
        assert!(argv.windows(2).any(|w| w[0] == "-m" && w[1] == "/m/x.gguf"));
        assert!(argv.windows(2).any(|w| w[0] == "--port" && w[1] == "8787"));
        assert!(argv.windows(2).any(|w| w[0] == "-ngl" && w[1] == "99"));
    }
}
