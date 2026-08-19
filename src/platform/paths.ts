import os from "os"
import path from "path"

// Replaces @codegoblin/core/global. The original also adopted legacy
// "opencode" directories; a fresh product has no legacy to adopt, so this is
// just XDG resolution. If real users ever migrate here, re-add adoption.
const app = "codegoblin"
const home = () => process.env.CODEGOBLIN_TEST_HOME ?? os.homedir()

const xdg = (envVar: string, fallback: string) =>
  path.join(process.env[envVar] ?? path.join(home(), fallback), app)

const data = xdg("XDG_DATA_HOME", ".local/share")
const cache = xdg("XDG_CACHE_HOME", ".cache")
const config = xdg("XDG_CONFIG_HOME", ".config")
const state = xdg("XDG_STATE_HOME", ".local/state")

export const Global = {
  Path: {
    get home() {
      return home()
    },
    data,
    cache,
    config,
    state,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    tmp: path.join(os.tmpdir(), app),
  },
}
