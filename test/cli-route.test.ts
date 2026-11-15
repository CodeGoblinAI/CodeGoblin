import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { route, helpText, WORKER_FLAGS } from "../src/cli/route"
import { InstallationVersion } from "../src/platform/version"
import { workerCommand, isCompiled } from "../src/platform/self"
import { loadCatalog } from "../src/core/catalog"

describe("what `codegoblin ...` starts", () => {
  test("nothing, a folder or a flag opens the terminal app with every argument passed on", () => {
    expect(route([])).toEqual({ kind: "tui", args: [] })
    expect(route(["../other"])).toEqual({ kind: "tui", args: ["../other"] })
    expect(route(["--model", "zai/glm-5.3"])).toEqual({ kind: "tui", args: ["--model", "zai/glm-5.3"] })
    // A folder that shares a command's name is reached by its path.
    expect(route(["./web"])).toEqual({ kind: "tui", args: ["./web"] })
  })

  test("web and run take their own word off the front", () => {
    expect(route(["web"])).toEqual({ kind: "web", args: [] })
    expect(route(["run", "--model", "zai/glm-5.3", "why is the sky blue"])).toEqual({ kind: "run", args: ["--model", "zai/glm-5.3", "why is the sky blue"] })
  })

  test("version, help and upgrade, by flag or by word", () => {
    for (const word of ["--version", "-v", "version"]) expect(route([word])).toEqual({ kind: "version" })
    for (const word of ["--help", "-h", "help"]) expect(route([word])).toEqual({ kind: "help" })
    expect(route(["upgrade"])).toEqual({ kind: "upgrade", args: [] })
    expect(route(["update", "0.4.1"])).toEqual({ kind: "upgrade", args: ["0.4.1"] })
  })

  test("the words the app uses to start a helper copy of itself", () => {
    expect(route([WORKER_FLAGS.voice])).toEqual({ kind: "worker", name: "voice" })
    expect(route([WORKER_FLAGS.cursor])).toEqual({ kind: "worker", name: "cursor" })
  })

  test("help names the command it was started as, and every way in", () => {
    const text = helpText("cg", "0.4.0")
    expect(text).toContain("CodeGoblin 0.4.0")
    for (const line of ["cg web", 'cg run "<prompt>"', "cg upgrade", "cg --version", "cg <folder>"]) expect(text).toContain(line)
  })
})

describe("what differs between source and the built program", () => {
  test("from source the version is package.json's, marked as a development copy", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }
    expect(isCompiled).toBe(false)
    if (!process.env.CODEGOBLIN_VERSION) expect(InstallationVersion).toBe(pkg.version + "-dev")
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("from source a helper is started as Bun running its file", () => {
    const command = workerCommand("voice", new URL("../src/core/voice-worker.ts", import.meta.url))
    expect(command[0]).toBe(process.execPath)
    expect(command[1]!.replace(/\\/g, "/")).toEndWith("src/core/voice-worker.ts")
  })

  test("the web app's files are real files from source", async () => {
    const { ASSETS } = await import("../src/web/assets")
    for (const [name, file] of Object.entries(ASSETS)) expect(fs.existsSync(file), name + " -> " + file).toBe(true)
  })

  test("from source no catalogue is carried: with no cache and no connection there are only the built-ins", async () => {
    const offline = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    const snapshot = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "src", "core", "catalog-snapshot.json"), "utf8"))
    expect(snapshot).toEqual({ at: 0, providers: [] })
    const cacheFile = path.join(process.env.CODEGOBLIN_DIR!, "cache", "models-dev.json")
    if (!fs.existsSync(cacheFile)) expect(await loadCatalog({ fetch: offline })).toEqual([])
  })
})
