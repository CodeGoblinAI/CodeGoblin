import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"

const app = "codegoblin"
const legacyApp = "opencode"

/**
 * CodeGoblin used to store its data under the upstream "opencode" directories. Adopt an existing
 * legacy directory by renaming it the first time the branded path is missing — instant on the
 * same volume and preserves sessions, auth, and the multi-GB local runtime. If the rename fails
 * (e.g. an older binary still holds a database open), keep using the legacy path for this run.
 */
export function adoptLegacyDir(next: string, legacy: string): string {
  if (fsSync.existsSync(next) || !fsSync.existsSync(legacy)) return next
  try {
    fsSync.renameSync(legacy, next)
    return next
  } catch {
    return legacy
  }
}

const data = adoptLegacyDir(path.join(xdgData!, app), path.join(xdgData!, legacyApp))
const cache = adoptLegacyDir(path.join(xdgCache!, app), path.join(xdgCache!, legacyApp))
const config = adoptLegacyDir(path.join(xdgConfig!, app), path.join(xdgConfig!, legacyApp))
const state = adoptLegacyDir(path.join(xdgState!, app), path.join(xdgState!, legacyApp))
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return (process.env.CODEGOBLIN_TEST_HOME ?? process.env.OPENCODE_TEST_HOME) ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@codegoblin/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.CODEGOBLIN_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
