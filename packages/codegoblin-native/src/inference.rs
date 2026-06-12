//! Inference backend for the CodeGoblin first-party local runtime.
//!
//! Slice 1 ships the serving plumbing only; generation is feature-gated so the
//! default build (and CI) never has to compile llama.cpp / CUDA. Building with
//! `--features inference` is where the real llama.cpp-backed engine lands
//! (Slice 2), driven from the user's GPU machine.

/// A single chat turn passed to the backend.
// Fields are consumed by the `inference` feature path (Slice 2); the stub build ignores them.
#[allow(dead_code)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// Parameters for one generation request.
#[allow(dead_code)]
pub struct GenerateParams {
    pub model: String,
    pub messages: Vec<Message>,
    pub max_tokens: usize,
}

/// Whether a real inference backend is compiled in.
pub const fn backend_available() -> bool {
    cfg!(feature = "inference")
}

/// Short label describing the active backend, for `/v1/models` and logs.
pub fn backend_label() -> &'static str {
    if backend_available() {
        "llama.cpp"
    } else {
        "stub (build with --features inference)"
    }
}

#[cfg(not(feature = "inference"))]
pub fn generate(_params: &GenerateParams) -> String {
    "CodeGoblin's local runtime is online, but this build has no inference backend. \
     Rebuild codegoblin-native with `--features inference` and point CODEGOBLIN_NATIVE_MODEL \
     at a GGUF model file to enable on-device generation."
        .to_string()
}

#[cfg(feature = "inference")]
pub fn generate(params: &GenerateParams) -> String {
    // Slice 2: load the GGUF model from CODEGOBLIN_NATIVE_MODEL via llama-cpp-2,
    // build the prompt from `params.messages`, run generation up to
    // `params.max_tokens`, and return the decoded text.
    let _ = params;
    "CodeGoblin local inference is enabled but model loading is not implemented yet (Slice 2).".to_string()
}
