import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseConfig } from "../src/core/config"
import { builtIns, formatAfterWrite, formatterFor, formattersFor } from "../src/core/formatter"
import { runTool } from "../src/core/tools"

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), "cg-format-"))
/** A formatter that upper-cases the file, so a test can see it ran. */
function shouting(dir: string): string {
  const script = path.join(dir, "shout.mjs")
  fs.writeFileSync(script, 'import fs from "node:fs"; const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").toUpperCase())\n')
  return script
}

describe("the formatter setting, in the fork's shape", () => {
  test("off unless asked; true turns on the built-ins; an object adds overrides", () => {
    expect(parseConfig("{}").formatter).toEqual({ enabled: false, entries: {} })
    expect(parseConfig('{"formatter": false}').formatter.enabled).toBe(false)
    expect(parseConfig('{"formatter": true}').formatter).toEqual({ enabled: true, entries: {} })
    const custom = parseConfig('{"formatter": {"prettier": {"disabled": true}, "shout": {"command": ["node", "x.mjs", "$FILE"], "extensions": ["txt"]}, "bad": {"command": "not a list"}}}').formatter
    expect(custom.enabled).toBe(true)
    expect(custom.entries.prettier).toEqual({ disabled: true })
    expect(custom.entries.shout).toEqual({ command: ["node", "x.mjs", "$FILE"], extensions: [".txt"] })
    expect(custom.entries.bad).toEqual({})
  })
})

describe("which formatter applies", () => {
  test("prettier only where the project depends on it and has its own copy - never a download", () => {
    const root = project()
    expect(builtIns(root, { PATH: "" }).map((f) => f.name)).toEqual([])
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { prettier: "^3" } }))
    expect(builtIns(root, { PATH: "" }).map((f) => f.name)).toEqual([])
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true })
    fs.writeFileSync(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier"), "")
    const found = builtIns(root, { PATH: "" })
    expect(found.map((f) => f.name)).toEqual(["prettier"])
    expect(formatterFor("src/app.ts", found)?.name).toBe("prettier")
    expect(formatterFor("main.go", found)).toBeUndefined()
  })

  test("a disabled built-in is skipped, and a custom one needs both a command and extensions", () => {
    const root = project()
    const config = parseConfig('{"formatter": {"shout": {"command": ["node", "s.mjs", "$FILE"], "extensions": [".txt"]}, "half": {"command": ["x"]}}}').formatter
    expect(formattersFor(root, config, { PATH: "" }).map((f) => f.name)).toEqual(["shout"])
  })
})

describe("formatting after a write", () => {
  test("runs on the file the model wrote, and tells the model it changed", async () => {
    const root = project()
    const config = parseConfig(JSON.stringify({ formatter: { shout: { command: [process.execPath, shouting(root), "$FILE"], extensions: [".txt"] } } })).formatter
    const file = path.join(root, "note.txt")
    fs.writeFileSync(file, "quiet words\n")
    expect(await formatAfterWrite(root, file, { config })).toContain("formatted with shout - read it again before editing it")
    expect(fs.readFileSync(file, "utf8")).toBe("QUIET WORDS\n")
    // Already formatted: nothing to say.
    expect(await formatAfterWrite(root, file, { config })).toBe("")
    // A file no formatter claims is left alone.
    fs.writeFileSync(path.join(root, "a.md"), "x")
    expect(await formatAfterWrite(root, path.join(root, "a.md"), { config })).toBe("")
  })

  test("a formatter that fails leaves the file as written and says so", async () => {
    const root = project()
    const config = parseConfig(JSON.stringify({ formatter: { broken: { command: [process.execPath, "-e", "process.stderr.write('syntax error on line 1'); process.exit(2)", "$FILE"], extensions: [".txt"] } } })).formatter
    const file = path.join(root, "note.txt")
    fs.writeFileSync(file, "as written\n")
    const note = await formatAfterWrite(root, file, { config })
    expect(note).toContain("broken could not format it: syntax error on line 1")
    expect(fs.readFileSync(file, "utf8")).toBe("as written\n")
  })

  test("off by default: write_file's result is unchanged", async () => {
    const root = project()
    const result = await runTool("write_file", { path: "x.ts", content: "const a=1\n" }, root)
    expect(result).not.toContain("formatted")
    expect(fs.readFileSync(path.join(root, "x.ts"), "utf8")).toBe("const a=1\n")
  })
})

describe.if(process.platform === "win32")("a .cmd formatter on Windows (a project's prettier or biome)", () => {
  /** A stand-in that records the path it was given, as node_modules/.bin/prettier.cmd would format it. */
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-fmt-cmd-"))
    const bin = path.join(root, "node_modules", ".bin")
    fs.mkdirSync(bin, { recursive: true })
    const script = path.join(bin, "fakefmt.cmd")
    // As npm's shims do: %* passes the arguments on with their quotes.
    fs.writeFileSync(script, "@echo %*>> \"%~dp0given.txt\"\r\n")
    const config = { enabled: true, entries: { fakefmt: { command: [script, "$FILE"], extensions: [".js"] } } }
    return { root, given: () => fs.readFileSync(path.join(bin, "given.txt"), "utf8").trim().replace(/^"(.*)"$/, "$1"), config: config as never }
  }

  test("a file name with & in it is a name, not a second command", async () => {
    const { root, config, given } = setup()
    const file = path.join(root, "a&mkdir INJECTED&.js")
    fs.writeFileSync(file, "x")
    await formatAfterWrite(root, file, { config })
    expect(fs.existsSync(path.join(root, "INJECTED"))).toBe(false)
    expect(given()).toBe(file)
  })

  test("a path with a space in it reaches the formatter as one path", async () => {
    const { root, config, given } = setup()
    fs.mkdirSync(path.join(root, "John Smith"))
    const file = path.join(root, "John Smith", "app.js")
    fs.writeFileSync(file, "x")
    expect(await formatAfterWrite(root, file, { config })).toBe("")
    expect(given()).toBe(file)
  })

  test("a name with % in it is left as written, since cmd.exe expands it even in quotes", async () => {
    const { root, config } = setup()
    const file = path.join(root, "%PATH%.js")
    fs.writeFileSync(file, "x")
    expect(await formatAfterWrite(root, file, { config })).toContain("was not run")
  })
})
