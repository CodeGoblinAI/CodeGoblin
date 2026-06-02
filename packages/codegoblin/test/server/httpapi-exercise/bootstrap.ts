/**
 * Must load before any @codegoblin/core module that reads xdg-basedir paths.
 * Imported from script/httpapi-exercise.ts before the exerciser index module.
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = process.env.TMPDIR ?? os.tmpdir()
const globalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ?? path.join(tmpRoot, `opencode-httpapi-global-${process.pid}`)

process.env.XDG_DATA_HOME = path.join(globalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(globalRoot, "config")
process.env.XDG_STATE_HOME = path.join(globalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(globalRoot, "cache")
process.env.OPENCODE_DISABLE_SHARE = "true"

process.env.OPENCODE_DB =
  process.env.OPENCODE_HTTPAPI_EXERCISE_DB ?? path.join(tmpRoot, `opencode-httpapi-exercise-${process.pid}.db`)

fs.mkdirSync(path.join(globalRoot, "config", "opencode"), { recursive: true })
fs.mkdirSync(path.join(globalRoot, "data", "opencode"), { recursive: true })
