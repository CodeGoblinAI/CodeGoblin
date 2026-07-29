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

  CODEGOBLIN_AUTO_HEAP_SNAPSHOT: truthy("AUTO_HEAP_SNAPSHOT"),
  CODEGOBLIN_GIT_BASH_PATH: raw("GIT_BASH_PATH"),
  CODEGOBLIN_DISABLE_AUTOUPDATE: truthy("DISABLE_AUTOUPDATE"),
  CODEGOBLIN_ALWAYS_NOTIFY_UPDATE: truthy("ALWAYS_NOTIFY_UPDATE"),
  CODEGOBLIN_DISABLE_PRUNE: truthy("DISABLE_PRUNE"),
  CODEGOBLIN_DISABLE_TERMINAL_TITLE: truthy("DISABLE_TERMINAL_TITLE"),
  CODEGOBLIN_SHOW_TTFD: truthy("SHOW_TTFD"),
  CODEGOBLIN_DISABLE_AUTOCOMPACT: truthy("DISABLE_AUTOCOMPACT"),
  CODEGOBLIN_DISABLE_MODELS_FETCH: truthy("DISABLE_MODELS_FETCH"),
  CODEGOBLIN_DISABLE_MOUSE: truthy("DISABLE_MOUSE"),
  CODEGOBLIN_FAKE_VCS: raw("FAKE_VCS"),
  CODEGOBLIN_SERVER_PASSWORD: serverPassword,
  CODEGOBLIN_SERVER_USERNAME: serverUsername,

  // Experimental
  CODEGOBLIN_EXPERIMENTAL_FILEWATCHER: boolConfig("EXPERIMENTAL_FILEWATCHER"),
  CODEGOBLIN_EXPERIMENTAL_DISABLE_FILEWATCHER: boolConfig("EXPERIMENTAL_DISABLE_FILEWATCHER"),
  CODEGOBLIN_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  CODEGOBLIN_MODELS_URL: raw("MODELS_URL"),
  CODEGOBLIN_MODELS_PATH: raw("MODELS_PATH"),
  CODEGOBLIN_DB: raw("DB"),

  CODEGOBLIN_WORKSPACE_ID: raw("WORKSPACE_ID"),
  CODEGOBLIN_EXPERIMENTAL_WORKSPACES: EXPERIMENTAL || truthy("EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get CODEGOBLIN_CONFIG() {
    return raw("CONFIG")
  },
  get CODEGOBLIN_CONFIG_CONTENT() {
    return raw("CONFIG_CONTENT")
  },
  get CODEGOBLIN_DISABLE_PROJECT_CONFIG() {
    return truthy("DISABLE_PROJECT_CONFIG")
  },
  // Prints the per-request system-prompt/tool token breakdown to stderr so the
  // cacheable-vs-poisoned split can be measured against a real session.
  get CODEGOBLIN_CONTEXT_REPORT() {
    return truthy("CONTEXT_REPORT")
  },
  get CODEGOBLIN_TUI_CONFIG() {
    return raw("TUI_CONFIG")
  },
  get CODEGOBLIN_CONFIG_DIR() {
    return raw("CONFIG_DIR")
  },
  get CODEGOBLIN_PURE() {
    return truthy("PURE")
  },
  get CODEGOBLIN_PERMISSION() {
    return raw("PERMISSION")
  },
  get CODEGOBLIN_PLUGIN_META_FILE() {
    return raw("PLUGIN_META_FILE")
  },
  get CODEGOBLIN_CLIENT() {
    return raw("CLIENT") ?? "cli"
  },
  get CODEGOBLIN_WEB_UI_PATH() {
    return raw("WEB_UI_PATH")
  },
  get CODEGOBLIN_WEB_UI_DEV_URL() {
    return raw("WEB_UI_DEV_URL")
  },
  // Opt-in only. CodeGoblin no longer proxies upstream OpenCode by default.
  get CODEGOBLIN_WEB_UI_UPSTREAM() {
    return raw("WEB_UI_UPSTREAM")
  },
}
