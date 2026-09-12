import os from "os"
import path from "path"

// Replaces @codegoblin/core/global. The original also adopted legacy
// "opencode" directories; a fresh product has no legacy to adopt, so this is
// just XDG resolution. If real users ever migrate here, re-add adoption.
const app = "codegoblin"
const home = () => process.env.CODEGOBLIN_TEST_HOME ?? os.homedir()

const xdg = (envVar: string, fallback: string) =>
  path.join(process.env[envVar] ?? path.join(home(), fallback), app)

/**
 * Everything under one directory, when asked.
 *
 * These paths are deliberately the same ones the fork uses: the app name is
 * "codegoblin" in both, so a key added over there is already here and nobody
 * has to type it twice. That sharing is worth keeping - it is the reason this
 * repo could talk to a provider the first time it ran.
 *
 * What it is not worth is having no way out. The two write different
 * filenames today (the fork keeps kv.json, model.json, plugin-meta.json and a
 * database; this keeps sessions/, settings.json, media.json, memory.json), so
 * nothing collides - but that is a fact about today, not a guarantee, and
 * "run the new one without it touching the old one's directory" should not
 * require a code change.
 *
 * CODEGOBLIN_DIR moves all four somewhere else, which is also how you get a
 * throwaway profile for testing without exporting four XDG variables.
 */
const separate = process.env.CODEGOBLIN_DIR

const root = (envVar: string, fallback: string, leaf: string) =>
  separate ? path.join(separate, leaf) : xdg(envVar, fallback)

const data = root("XDG_DATA_HOME", ".local/share", "data")
const cache = root("XDG_CACHE_HOME", ".cache", "cache")
const config = root("XDG_CONFIG_HOME", ".config", "config")
const state = root("XDG_STATE_HOME", ".local/state", "state")

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
