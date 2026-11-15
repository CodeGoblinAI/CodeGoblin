// User pass: the built program (bun script/build.ts), on its own, the way an installed copy runs.
// It answers --version and --help, opens the terminal app, serves the web app's page and files from inside
// itself, and - started with no connection and a new profile - still knows the providers it was built with.
//   node test/user-pass/pass-binary.mjs [path to codegoblin(.exe)]
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import os from "node:os"

// On its own (not through harness.mjs), so it runs anywhere Node does - CI included.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
let failures = 0
const failed = () => failures
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "\n     " + String(detail).replace(/\n/g, "\n     ") : "")) }

const root = process.env.CG_ROOT ?? path.resolve(import.meta.dirname, "..", "..")
const names = { win32: "windows", linux: "linux", darwin: "darwin" }
const bin = process.argv[2] ?? path.join(root, "dist", `codegoblin-${names[process.platform]}-${process.arch}`, "bin", process.platform === "win32" ? "codegoblin.exe" : "codegoblin")
if (!fs.existsSync(bin)) { console.log("no built program at " + bin + " - run: bun script/build.ts"); process.exit(1) }
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const profile = tempDir("cg-binary-profile-")
const project = tempDir("cg-binary-project-")
const env = { ...process.env, CODEGOBLIN_DIR: profile, CODEGOBLIN_LOCAL_URL: "http://127.0.0.1:9/v1", CODEGOBLIN_LOCAL_MODEL: "fixture", CODEGOBLIN_MODELS_URL: "http://127.0.0.1:9/api.json" }
const run = (...args) => execFileSync(bin, args, { cwd: project, env, encoding: "utf8", timeout: 30000 }).trim()

const version = run("--version")
check("--version prints the released version, not a development one", /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) && !version.endsWith("-dev") && version.startsWith(pkg.version.split("-")[0]), version)
const help = run("--help")
check("--help lists every way in", ["codegoblin web", "codegoblin run", "codegoblin upgrade", "codegoblin <folder>"].every((line) => help.includes(line)), help)
check("a helper copy starts by its own word and ends when its input does", (() => { try { execFileSync(bin, ["__cursor-worker"], { cwd: project, env, input: "", timeout: 30000 }); return true } catch (error) { return error.status !== null && !/Cannot find module|ENOENT/.test(String(error.stderr)) } })())

const server = spawn(bin, ["web"], { cwd: project, env, windowsHide: true })
let log = ""
server.stdout.on("data", (chunk) => log += chunk); server.stderr.on("data", (chunk) => log += chunk)
try {
  for (let waited = 0; waited < 15000 && !/http:\/\/localhost:\d+/.test(log); waited += 200) await delay(200)
  const base = /http:\/\/localhost:\d+/.exec(log)?.[0]
  check("`web` starts the web app", Boolean(base), log)
  if (base) {
    for (const [route, type, least] of [["/", "text/html", 5000], ["/app.js", "javascript", 50000], ["/logo.png", "image/png", 500], ["/vendor/xterm.js", "javascript", 50000], ["/vendor/xterm.css", "text/css", 500], ["/vendor/addon-fit.js", "javascript", 500]]) {
      const response = await fetch(base + route)
      const size = (await response.arrayBuffer()).byteLength
      check(`${route} is served from inside the program`, response.status === 200 && (response.headers.get("content-type") ?? "").includes(type) && size >= least, response.status + " " + response.headers.get("content-type") + " " + size)
    }
    const settings = await fetch(base + "/api/settings", { headers: { origin: base } })
    check("the app's own API answers", settings.status === 200, String(settings.status))
    // A new profile and no way to reach the catalogue: the providers on offer are the ones it was built with.
    await delay(1500)
    const offered = (await (await fetch(base + "/api/commands", { headers: { origin: base } })).json()).connectable ?? []
    check("with no connection and a new profile it still offers the catalogue's providers", offered.length > 100 && !fs.existsSync(path.join(profile, "cache", "models-dev.json")), offered.length + " providers offered")
  }
} finally { server.kill() }
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(failed() ? 1 : 0)
