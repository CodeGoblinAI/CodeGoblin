// Installing what would be published, the way a person does, and starting it by name.
//
// Packs the installer package and this computer's program (as `npm publish` would), installs both into a
// throwaway npm prefix - never the real global one - and runs the `codegoblin` and `cg` commands npm made.
// Then `upgrade`, against a stand-in registry and with --dry-run, so nothing is ever installed over a real copy.
//
//   bun script/build.ts && node test/user-pass/pass-install.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const dist = path.join(root, "dist")
const windows = process.platform === "win32"
const program = `codegoblin-${{ win32: "windows", linux: "linux", darwin: "darwin" }[process.platform]}-${process.arch}`
let failures = 0
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "\n      " + String(detail).trim().split("\n").join("\n      ") : "")) }
const sh = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: windows, timeout: 300_000, ...options })
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") }
}

if (!fs.existsSync(path.join(dist, "codegoblin", "package.json")) || !fs.existsSync(path.join(dist, program, "package.json"))) {
  console.error("Nothing built for this computer. Run: bun script/build.ts"); process.exit(1)
}
const version = JSON.parse(fs.readFileSync(path.join(dist, "codegoblin", "package.json"), "utf8")).version
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cg-install-"))
const prefix = path.join(work, "prefix")
const cache = path.join(work, "npm-cache")
fs.mkdirSync(prefix, { recursive: true })

// 1. What would be uploaded.
const pack = (folder) => {
  const result = sh("npm", ["pack", "--json", "--pack-destination", work], { cwd: path.join(dist, folder) })
  try { const [info] = JSON.parse(result.out.slice(result.out.indexOf("["))); return { file: path.join(work, info.filename), files: info.files.map((file) => file.path), size: info.size } } catch { return { error: result.out } }
}
const installer = pack("codegoblin")
const native = pack(program)
check("the installer package holds only the launcher, the readme and the licence", !installer.error && JSON.stringify([...installer.files].sort()) === JSON.stringify(["LICENSE", "README.md", "bin/codegoblin.mjs", "package.json"]), installer.error ?? installer.files.join(", "))
check("the program package holds the program", !native.error && native.files.some((file) => /^bin\/codegoblin(\.exe)?$/.test(file)), native.error ?? `${native.files.join(", ")} (${Math.round(native.size / 1e6)} MB packed)`)

// 2. Install into a prefix of its own. The other platforms' programs are not on the registry at this version;
//    they are optional, so npm leaves them out, as it does for every platform but one on a real install.
const env = { ...process.env, npm_config_prefix: prefix, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", CODEGOBLIN_DIR: path.join(work, "profile"), CODEGOBLIN_DISABLE_AUTOUPDATE: "1" }
const installed = installer.file && native.file ? sh("npm", ["install", "-g", installer.file, native.file], { env }) : { code: 1, out: "nothing packed" }
check("npm installs it", installed.code === 0, installed.out.slice(-400))
const bin = windows ? prefix : path.join(prefix, "bin")
const command = (name) => path.join(bin, windows ? name + ".cmd" : name)
check("npm made the `codegoblin` and `cg` commands", fs.existsSync(command("codegoblin")) && fs.existsSync(command("cg")), fs.readdirSync(bin).join(", "))

// 3. Start it by name.
const quoted = (name) => (windows ? `"${command(name)}"` : command(name))
const shown = sh(quoted("codegoblin"), ["--version"], { env })
check("`codegoblin --version` is the built program answering", shown.code === 0 && shown.out.trim() === version, shown.out)
const short = sh(quoted("cg"), ["--help"], { env })
check("`cg --help` lists the commands", short.code === 0 && /codegoblin upgrade/.test(short.out) && short.out.includes(version), short.out.slice(0, 300))
const exits = sh(quoted("codegoblin"), ["run"], { env })
check("an exit code comes back through the launcher", exits.code !== 0 && exits.code !== null, `exit ${exits.code}: ${exits.out.slice(0, 160)}`)

// 4. upgrade, against a registry that is not the real one, installing nothing.
const tags = { latest: version }
const registry = http.createServer((request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ name: "@codegoblin-io/codegoblin", "dist-tags": tags })) })
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve))
const upgradeEnv = { ...env, CODEGOBLIN_REGISTRY_URL: "http://127.0.0.1:" + registry.address().port }
// spawnSync would block the stand-in registry in this same process, so these run through a child that can wait.
const later = (args) => new Promise((resolve) => {
  import("node:child_process").then(({ spawn }) => {
    const child = spawn(quoted("codegoblin"), args, { env: upgradeEnv, shell: windows })
    let out = ""
    child.stdout.on("data", (data) => out += data); child.stderr.on("data", (data) => out += data)
    child.on("exit", (code) => resolve({ code, out }))
  })
})
const same = await later(["upgrade"])
check("upgrade: says so when this is the newest", same.code === 0 && same.out.includes(`CodeGoblin ${version} is the newest version`), same.out)
tags.latest = "9.9.9"
const dry = await later(["upgrade", "--dry-run"])
check("upgrade: names the new version and the exact command, and --dry-run installs nothing", dry.code === 0 && dry.out.includes(`CodeGoblin ${version} would be updated to 9.9.9 with: npm install -g @codegoblin-io/codegoblin@9.9.9`), dry.out)
const back = await later(["upgrade", "0.3.12", "--dry-run"])
check("upgrade <number>: goes to exactly that version, older ones included", back.code === 0 && back.out.includes("@codegoblin-io/codegoblin@0.3.12"), back.out)
const unknown = await later(["upgrade", "nightly", "--dry-run"])
check("upgrade <unknown word>: explains, and installs nothing", unknown.code === 1 && /no "nightly" version/.test(unknown.out), unknown.out)
tags.latest = "9.9.9 & calc"
const hostile = await later(["upgrade", "--dry-run"])
check("upgrade: a registry answer that is not a version never reaches a command line", hostile.code === 0 && hostile.out.includes("is the newest version") && !hostile.out.includes("calc"), hostile.out)
registry.close()
const after = sh(quoted("codegoblin"), ["--version"], { env })
check("the installed copy is unchanged after all of that", after.out.trim() === version, after.out)

// A hundred megabytes or so of packed and installed program: to the Recycle Bin, never a permanent delete.
let left = work
if (!failures && windows && work.startsWith(os.tmpdir()) && fs.existsSync(prefix)) {
  const bin = spawnSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CG_INSTALL_BOX, 'OnlyErrorDialogs', 'SendToRecycleBin')"], { env: { ...process.env, CG_INSTALL_BOX: work } })
  if (bin.status === 0) left = ""
}
console.log((failures ? `\n${failures} failed.` : "\nAll passed.") + (left ? ` Left in ${left}` : ""))
process.exit(failures ? 1 : 0)
