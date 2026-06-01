import { Config } from "effect"

// Resolve a flag env var by its suffix, preferring the CodeGoblin-branded name
// (CODEGOBLIN_<suffix>) and falling back to the legacy OpenCode name
// (OPENCODE_<suffix>) for backward compatibility. Existing OPENCODE_* setups
// keep working unchanged; CODEGOBLIN_* takes precedence when both are set.
function raw(suffix: string) {
  return process.env["CODEGOBLIN_" + suffix] ?? process.env["OPENCODE_" + suffix]
}

function truthy(suffix: string) {
  const value = raw(suffix)?.toLowerCase()
  return value === "true" || value === "1"
}

// Effect Config variant of the same fallback: prefer CODEGOBLIN_<suffix>, then
// OPENCODE_<suffix>, then the provided default.
function boolConfig(suffix: string) {
  return Config.boolean("CODEGOBLIN_" + suffix).pipe(
    Config.orElse(() => Config.boolean("OPENCODE_" + suffix)),
    Config.withDefault(false),
  )
}

const EXPERIMENTAL = truthy("EXPERIMENTAL")
const copy = raw("EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const serverPassword = raw("SERVER_PASSWORD")
const serverUsername = raw("SERVER_USERNAME")

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: raw("GIT_BASH_PATH"),
  OPENCODE_DISABLE_AUTOUPDATE: truthy("DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: raw("FAKE_VCS"),
  CODEGOBLIN_SERVER_PASSWORD: serverPassword,
  CODEGOBLIN_SERVER_USERNAME: serverUsername,
  OPENCODE_SERVER_PASSWORD: serverPassword,
  OPENCODE_SERVER_USERNAME: serverUsername,

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: boolConfig("EXPERIMENTAL_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: boolConfig("EXPERIMENTAL_DISABLE_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: raw("MODELS_URL"),
  OPENCODE_MODELS_PATH: raw("MODELS_PATH"),
  OPENCODE_DB: raw("DB"),

  OPENCODE_WORKSPACE_ID: raw("WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: EXPERIMENTAL || truthy("EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_CONFIG() {
    return raw("CONFIG")
  },
  get OPENCODE_CONFIG_CONTENT() {
    return raw("CONFIG_CONTENT")
  },
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_TUI_CONFIG() {
    return raw("TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return raw("CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthy("PURE")
  },
  get OPENCODE_PERMISSION() {
    return raw("PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return raw("PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return raw("CLIENT") ?? "cli"
  },
}
