import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"

// test/preload.ts gives each run a directory of its own before any test file
// loads. If that ever stops being true - the preload dropped from bunfig.toml,
// the tests started some other way - this is the file that says so out loud.
describe("a test run never reaches the real profile", () => {
  const dirs = { data: Global.Path.data, cache: Global.Path.cache, config: Global.Path.config, state: Global.Path.state }

  test("the preload made a sandbox for this run", () => {
    expect(process.env.CODEGOBLIN_TEST_SANDBOX).toBeTruthy()
  })

  for (const [name, dir] of Object.entries(dirs)) {
    test(`${name} is inside it`, () => {
      expect(() => requireSandbox(path.join(dir, "probe"), name)).not.toThrow()
    })
  }

  test("and none of them is where the real profile lives", () => {
    const real = [".local/share", ".local/state", ".config", ".cache"].map((dir) => path.resolve(os.homedir(), dir, "codegoblin"))
    for (const dir of Object.values(dirs)) {
      expect(real).not.toContain(path.resolve(dir))
    }
  })

  test("the guard refuses a file outside it", () => {
    const store = path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json")
    expect(() => requireSandbox(store, "a test")).toThrow("refusing to run a test")
  })
})
