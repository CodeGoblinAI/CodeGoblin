// User pass: the awkward first minutes. A damaged profile, a folder with spaces and non-English letters in its
// name, no terminal, no key, a folder that is not there. Nothing here needs a model or a connection.
// Runs the built program when there is one (bun script/build.ts), else the source.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const names = { win32: "windows", linux: "linux", darwin: "darwin" }
const built = path.join(root, "dist", `codegoblin-${names[process.platform]}-${process.arch}`, "bin", process.platform === "win32" ? "codegoblin.exe" : "codegoblin")
if (!process.env.CG_BIN && fs.existsSync(built)) process.env.CG_BIN = built
const { check, failed, fakeModel, tempDir, tui, web, delay } = await import("./harness.mjs")
const command = (...args) => (process.env.CG_BIN ? [process.env.CG_BIN, args] : [process.platform === "win32" ? "bun.exe" : "bun", [path.join(root, "src", "cli", "main.ts"), ...args]])
const run = (args, options = {}) => { const [file, all] = command(...args); const result = spawnSync(file, all, { encoding: "utf8", timeout: 30000, windowsHide: true, ...options }); return { code: result.status, signal: result.signal, out: (result.stdout ?? "") + (result.stderr ?? "") } }
const model = await fakeModel(() => ({ text: "hello from the fixture" }))
const baseEnv = (profile) => ({ ...process.env, CODEGOBLIN_DIR: profile, CODEGOBLIN_DISABLE_AUTOUPDATE: "1", CODEGOBLIN_MODELS_URL: "http://127.0.0.1:9/api.json", CODEGOBLIN_LOCAL_URL: model.url, CODEGOBLIN_LOCAL_MODEL: "fixture", CODEGOBLIN_LOCAL_TOOLS: "1" })
const crashed = (text) => /TypeError|ReferenceError|SyntaxError|Unhandled|panic|at .*\(.*:\d+:\d+\)|\bat <anonymous>/.test(text)

// 1. A profile where every file CodeGoblin keeps has been damaged.
{
  const profile = tempDir("cg-outlier-broken-")
  for (const dir of ["data", "state", "config", "cache", path.join("state", "sessions")]) fs.mkdirSync(path.join(profile, dir), { recursive: true })
  fs.writeFileSync(path.join(profile, "data", "auth.json"), '{"zai": {"type": "api", "key": ')
  fs.writeFileSync(path.join(profile, "state", "settings.json"), "\u0000\u0000\u0000")
  fs.writeFileSync(path.join(profile, "state", "memory.json"), "[[[")
  fs.writeFileSync(path.join(profile, "state", "update.json"), "nope")
  fs.writeFileSync(path.join(profile, "state", "provider-addresses.json"), '["not", "a", "map"]')
  fs.writeFileSync(path.join(profile, "config", "codegoblin.jsonc"), '{ "mcp": { "x": { "command": 5 } }, "permission": "yes", ')
  fs.writeFileSync(path.join(profile, "cache", "models.json"), "{")
  fs.writeFileSync(path.join(profile, "state", "sessions", "broken.json"), '{"id":"broken","messages":[{"role":"user"')
  fs.writeFileSync(path.join(profile, "state", "sessions", "empty.json"), "")
  fs.writeFileSync(path.join(profile, "state", "sessions", "wrong.json"), '{"id":"wrong","title":7,"messages":"none","updated":"yesterday"}')
  const project = tempDir("cg-outlier-project-")
  const t = await tui({ model, cwd: project, profile, extraEnv: { CODEGOBLIN_MODELS_URL: "http://127.0.0.1:9/api.json" } }).catch((error) => ({ failed: error.message }))
  if (t.failed) check("TUI: starts on a damaged profile", false, t.failed.slice(-600))
  else {
    try {
      check("TUI: starts on a damaged profile", /ask the goblin/i.test(t.screen()) && !crashed(t.screen()))
      t.write("hi\r"); await t.until((s) => /hello from the fixture/.test(s), 15000, "a turn")
      check("TUI: and answers a prompt", true)
      t.write("/resume\r"); await delay(1500)
      check("TUI: the conversation list opens with damaged conversations in the folder", !crashed(t.screen()), t.screen().slice(-500))
      t.write("\x1b"); await delay(300)
      for (const slash of ["/status", "/memory", "/mcp", "/usage", "/settings"]) { t.write(slash + "\r"); await delay(900); t.write("\x1b"); await delay(300) }
      check("TUI: /status, /memory, /mcp, /usage and /settings open without an error on screen", !crashed(t.screen()), t.screen().split("\n").filter((l) => crashed(l)).join("\n"))
    } catch (error) { check("TUI on a damaged profile", false, error.message) } finally { t.kill() }
  }
  const w = await web({ model, cwd: project, profile, extraEnv: { CODEGOBLIN_MODELS_URL: "http://127.0.0.1:9/api.json" } }).catch((error) => ({ failed: error.message }))
  if (w.failed) check("web: starts on a damaged profile", false, w.failed.slice(-600))
  else {
    try {
      const body = await w.page.locator("body").innerText()
      check("web: starts on a damaged profile", /What should we work on/.test(body) || body.length > 50, body.slice(0, 200))
      check("web: no errors in the page", w.errors.length === 0, w.errors.join(" | ").slice(0, 400))
    } catch (error) { check("web on a damaged profile", false, error.message) } finally { await w.close() }
  }
}

// 2. A project folder with spaces and letters outside ASCII in its name.
{
  const project = path.join(tempDir("cg-outlier-names-"), "my projet été 日本語 (v2)")
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "naïve file.txt"), "contents of the oddly named file")
  let asked = []
  const reader = await fakeModel((sent) => { asked = sent.messages; const last = sent.messages.at(-1); return last?.role === "tool" ? { text: "done reading" } : { tool: "read_file", args: { path: "naïve file.txt" } } })
  const t = await tui({ model: reader, cwd: project }).catch((error) => ({ failed: error.message }))
  if (t.failed) check("TUI: starts in a folder with spaces and non-English letters", false, t.failed.slice(-400))
  else {
    try {
      check("TUI: starts in a folder with spaces and non-English letters", /ask the goblin/i.test(t.screen()))
      t.write("read it\r"); await t.until((s) => /done reading/.test(s), 20000, "a tool turn")
      check("TUI: a file with an accent in its name is read", asked.some((m) => m.role === "tool" && /contents of the oddly named file/.test(m.content)), JSON.stringify(asked.filter((m) => m.role === "tool").map((m) => m.content.slice(0, 80))))
    } catch (error) { check("odd names", false, error.message) } finally { t.kill(); reader.close() }
  }
}

// 3. No terminal at all: started with its input and output as pipes.
{
  const profile = tempDir("cg-outlier-notty-")
  const result = run([], { env: baseEnv(profile), input: "hello\n", cwd: tempDir("cg-outlier-p-") })
  check("no terminal: it says so and exits, rather than hanging or drawing into a pipe", result.signal === null && result.code === 1 && !crashed(result.out) && /not a terminal/.test(result.out) && /run "<prompt>"/.test(result.out) && !/\[/.test(result.out), `exit ${result.code} signal ${result.signal}: ${result.out.slice(0, 300)}`)
}

// 4. Asked for things that cannot be.
{
  const profile = tempDir("cg-outlier-misc-")
  const env = { ...baseEnv(profile), CODEGOBLIN_LOCAL_URL: "", CODEGOBLIN_LOCAL_MODEL: "" }
  const nowhere = run([path.join(os.tmpdir(), "cg-no-such-folder-" + Date.now())], { env, input: "" })
  check("a folder that is not there: a sentence, not a stack trace", nowhere.code !== 0 && !crashed(nowhere.out) && nowhere.out.trim().length > 0, `exit ${nowhere.code}: ${nowhere.out.slice(0, 300)}`)
  const noKey = run(["run", "say hi"], { env, cwd: tempDir("cg-outlier-p-") })
  check("`run` with no key anywhere: says how to connect one", noKey.code !== 0 && !crashed(noKey.out) && /connect|key/i.test(noKey.out), `exit ${noKey.code}: ${noKey.out.slice(0, 300)}`)
  const badModel = run(["run", "--model", "nobody/nothing", "say hi"], { env, cwd: tempDir("cg-outlier-p-") })
  check("`run --model` with a model that does not exist: says so", badModel.code !== 0 && !crashed(badModel.out) && badModel.out.trim().length > 0, `exit ${badModel.code}: ${badModel.out.slice(0, 300)}`)
  const flag = run(["--no-such-flag"], { env, input: "", cwd: tempDir("cg-outlier-p-") })
  check("an unknown option: it is named, and nothing opens", flag.code === 2 && /no option --no-such-flag/.test(flag.out) && !/\[/.test(flag.out), `exit ${flag.code}: ${flag.out.slice(0, 300)}`)
  const typo = run(["--modle", "zai/glm-5.3"], { env, input: "", cwd: tempDir("cg-outlier-p-") })
  check("a misspelt --model is caught rather than opening on another model", typo.code === 2 && /no option --modle/.test(typo.out), `exit ${typo.code}: ${typo.out.slice(0, 200)}`)
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
// On Windows, ending normally waits for ever on a pseudo-terminal helper after these particular checks, so
// this ends itself outright there. Read the last line for the result, not the exit code.
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
