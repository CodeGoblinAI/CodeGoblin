import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

/**
 * Where state lives.
 *
 * The module reads the environment once, when it loads, so each case imports
 * it fresh with a query string to defeat the module cache. That is the same
 * reason auth.test.ts imports dynamically.
 */
const freshPaths = async (env: Record<string, string | undefined>) => {
  const before: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    before[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const loaded = await import("../src/platform/paths?v=" + Math.random())
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return (loaded as typeof import("../src/platform/paths")).Global.Path
}

const home = path.join(os.tmpdir(), "cg-paths-home")

describe("by default, the same directories the fork uses", () => {
  test("state and data sit under the shared codegoblin directory", async () => {
    const paths = await freshPaths({
      CODEGOBLIN_DIR: undefined,
      CODEGOBLIN_TEST_HOME: home,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
    })

    // Sharing is the point: a key the fork stored is a key this can use.
    expect(paths.data).toBe(path.join(home, ".local", "share", "codegoblin"))
    expect(paths.state).toBe(path.join(home, ".local", "state", "codegoblin"))
  })

  test("an XDG variable still wins, the way it should", async () => {
    const paths = await freshPaths({
      CODEGOBLIN_DIR: undefined,
      CODEGOBLIN_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, "xdg-data"),
      XDG_STATE_HOME: undefined,
    })
    expect(paths.data).toBe(path.join(home, "xdg-data", "codegoblin"))
  })
})

describe("CODEGOBLIN_DIR moves everything at once", () => {
  const elsewhere = path.join(os.tmpdir(), "cg-paths-elsewhere")

  test("all four directories follow it", async () => {
    const paths = await freshPaths({
      CODEGOBLIN_DIR: elsewhere,
      CODEGOBLIN_TEST_HOME: home,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
    })

    expect(paths.data).toBe(path.join(elsewhere, "data"))
    expect(paths.state).toBe(path.join(elsewhere, "state"))
    expect(paths.config).toBe(path.join(elsewhere, "config"))
    expect(paths.cache).toBe(path.join(elsewhere, "cache"))
  })

  test("nothing is left pointing at the shared directory", async () => {
    const paths = await freshPaths({
      CODEGOBLIN_DIR: elsewhere,
      CODEGOBLIN_TEST_HOME: home,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
    })

    // Half a move is worse than none: one path left behind would put keys in
    // one profile and sessions in another.
    for (const each of [paths.data, paths.state, paths.config, paths.cache, paths.log, paths.bin]) {
      expect(each.startsWith(elsewhere)).toBe(true)
    }
  })

  test("it beats the XDG variables rather than combining with them", async () => {
    const paths = await freshPaths({
      CODEGOBLIN_DIR: elsewhere,
      CODEGOBLIN_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, "xdg-data"),
      XDG_STATE_HOME: path.join(home, "xdg-state"),
    })

    expect(paths.data).toBe(path.join(elsewhere, "data"))
    expect(paths.state).toBe(path.join(elsewhere, "state"))
  })
})
