// Going back to CodeGoblin 0.3 after this version has used the same profile.
//
// Both keep their files in the same folders, on purpose. This checks the promise that follows from it: 0.3, as
// installed on this machine, still starts and still has every conversation, key and setting after this version
// has started, saved a key, changed a setting and imported a conversation there - and while it is running.
//
// Nothing real is written. The profile is copied to a temporary folder (every key and token replaced by a dummy
// of the same length), and both programs are pointed at the copy. Costs nothing: no model is called.
//
//   bun test/user-pass/real-rollback.ts            needs `codegoblin` 0.3 on PATH
//   CG_BIN=<built program> bun test/user-pass/real-rollback.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { Database } from "bun:sqlite"

const repo = path.resolve(import.meta.dir, "..", "..")
const home = os.homedir()
const real = { data: path.join(home, ".local/share/codegoblin"), config: path.join(home, ".config/codegoblin"), state: path.join(home, ".local/state/codegoblin"), cache: path.join(home, ".cache/codegoblin") }
const box = fs.mkdtempSync(path.join(os.tmpdir(), "cg-rollback-"))
const xdg = { XDG_DATA_HOME: path.join(box, "data"), XDG_CONFIG_HOME: path.join(box, "config"), XDG_STATE_HOME: path.join(box, "state"), XDG_CACHE_HOME: path.join(box, "cache") }
const copy = { data: path.join(xdg.XDG_DATA_HOME, "codegoblin"), config: path.join(xdg.XDG_CONFIG_HOME, "codegoblin"), state: path.join(xdg.XDG_STATE_HOME, "codegoblin"), cache: path.join(xdg.XDG_CACHE_HOME, "codegoblin") }
const env = { ...process.env, ...xdg, CODEGOBLIN_DISABLE_AUTOUPDATE: "1" } as Record<string, string>
delete env.CODEGOBLIN_DIR
delete env.CODEGOBLIN_TEST_HOME

let failures = 0
const check = (name: string, ok: boolean, detail = "") => { if (!ok) failures++; console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  -  " + detail : "")) }
const sha = (file: string) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing")

/** Same shape, no secrets: every string that is not a `type` becomes x's of the same length. */
const dummy = (value: unknown, key = ""): unknown =>
  typeof value === "string" ? (key === "type" ? value : "x".repeat(value.length))
    : Array.isArray(value) ? value.map((entry) => dummy(entry))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, dummy(entry, name)])) : value

function copyProfile() {
  for (const dir of Object.values(copy)) fs.mkdirSync(dir, { recursive: true })
  for (const name of ["codegoblin.db", "codegoblin.db-wal"]) if (fs.existsSync(path.join(real.data, name))) fs.copyFileSync(path.join(real.data, name), path.join(copy.data, name))
  fs.writeFileSync(path.join(copy.data, "auth.json"), JSON.stringify(dummy(JSON.parse(fs.readFileSync(path.join(real.data, "auth.json"), "utf8"))), null, 2))
  for (const name of ["codegoblin.jsonc", "AGENTS.md"]) if (fs.existsSync(path.join(real.config, name))) fs.copyFileSync(path.join(real.config, name), path.join(copy.config, name))
  // 0.3's own state, and this version's, as they sit side by side today.
  for (const name of ["kv.json", "model.json", "plugin-meta.json", "settings.json", "memory.json"]) if (fs.existsSync(path.join(real.state, name))) fs.copyFileSync(path.join(real.state, name), path.join(copy.state, name))
  for (const name of fs.existsSync(real.cache) ? fs.readdirSync(real.cache) : []) if (name.endsWith(".json")) fs.copyFileSync(path.join(real.cache, name), path.join(copy.cache, name))
}

function old(...args: string[]) {
  const command = process.platform === "win32" ? ["cmd", "/c", "codegoblin", ...args] : ["codegoblin", ...args]
  const result = Bun.spawnSync(command, { env, cwd: box, stdout: "pipe", stderr: "pipe", timeout: 180_000 })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

/** What 0.3 reports about the profile: its conversations, its keys, its models. */
function oldView() {
  const version = old("--version")
  const sessions = old("session", "list", "--format", "json", "-n", "1000")
  let ids: string[] = []
  try { ids = (JSON.parse(sessions.out) as { id: string }[]).map((entry) => entry.id).sort() } catch {}
  const providers = old("providers", "list")
  const credentials = Number(/(\d+) credentials/.exec(providers.out)?.[1] ?? -1)
  const models = old("models")
  const first = ids[0] ? old("export", ids[0]) : undefined
  return {
    ok: version.code === 0 && sessions.code === 0 && providers.code === 0 && models.code === 0 && (!first || first.code === 0),
    version: version.out.trim(), ids, credentials, models: models.out.split("\n").filter((line) => line.includes("/")).length,
    exported: first ? first.out.length : 0, errors: [version, sessions, providers, models].map((run) => run.err.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean).join(" | ").slice(0, 300),
  }
}

const next = (...args: string[]) => (process.env.CG_BIN ? [process.env.CG_BIN, ...args] : [process.execPath, path.join(repo, "src/cli/main.ts"), ...args])

/** This version writing to the profile the way a person's use would: a key, a setting, an imported conversation. */
const USE = `
import { connect, connections } from ${JSON.stringify(path.join(repo, "src/core/auth.ts"))}
import * as settings from ${JSON.stringify(path.join(repo, "src/core/settings.ts"))}
import { listFork, importFork } from ${JSON.stringify(path.join(repo, "src/core/fork-import.ts"))}
import { Database } from "bun:sqlite"
const before = connections().length
await connect("groq", "rollback-proof-dummy-key")
const current = await settings.load()
await settings.save({ ...current, thinking: !current.thinking })
const db = new Database(process.env.XDG_DATA_HOME + "/codegoblin/codegoblin.db", { readonly: true })
const row = db.query("select directory from session where parent_id is null group by directory order by count(*) desc limit 1").get()
db.close()
const listed = await listFork(row.directory)
const imported = listed.sessions[0] ? await importFork(listed.sessions[0].id, row.directory, "groq") : undefined
console.log(JSON.stringify({ before, after: connections().length, listed: listed.sessions.length, imported: imported?.messages ?? 0 }))
`

copyProfile()
const fixed = ["kv.json", "model.json", "plugin-meta.json"].map((name) => path.join(copy.state, name)).concat(path.join(copy.config, "codegoblin.jsonc"))
const authBefore = JSON.parse(fs.readFileSync(path.join(copy.data, "auth.json"), "utf8")) as Record<string, unknown>

const first = oldView()
check("0.3 runs on the copied profile", first.ok && first.ids.length > 0, `${first.version}: ${first.ids.length} conversations, ${first.credentials} keys, ${first.models} models${first.errors ? " | " + first.errors : ""}`)
const hashes = Object.fromEntries(fixed.map((file) => [file, sha(file)]))

// This version: start it, use it, and leave its web app running while 0.3 is asked again.
const version = Bun.spawnSync(next("--version"), { env, cwd: box })
check("this version starts on the same profile", version.exitCode === 0, version.stdout.toString().trim())
const script = path.join(box, "use.ts")
fs.writeFileSync(script, USE)
const used = Bun.spawnSync([process.execPath, script], { env, cwd: box })
let report = { before: -1, after: -1, listed: 0, imported: 0 }
try { report = JSON.parse(used.stdout.toString().trim().split("\n").at(-1)!) } catch {}
check("this version saved a key, changed a setting and imported a 0.3 conversation", used.exitCode === 0 && report.after === report.before + 1 && report.imported > 0, JSON.stringify(report) + used.stderr.toString().slice(0, 300))

const web = Bun.spawn(next("web"), { env, cwd: box, stdout: "pipe", stderr: "pipe" })
const url = await new Promise<string | undefined>((resolve) => {
  let text = ""
  const timer = setTimeout(() => resolve(undefined), 30_000)
  void (async () => { for await (const chunk of web.stdout) { text += new TextDecoder().decode(chunk); const found = /http:\/\/localhost:\d+/.exec(text); if (found) { clearTimeout(timer); resolve(found[0]) } } })()
})
const offered = url ? await fetch(url + "/api/import?source=codegoblin").then((r) => r.json() as Promise<{ sessions?: unknown[] }>).catch(() => undefined) : undefined
check("its web app starts there and reads 0.3's conversations", Boolean(url) && Array.isArray(offered?.sessions), url ?? "did not start")

const during = oldView()
check("0.3 still runs while this version is open on the profile", during.ok, during.errors)
web.kill()
await web.exited

const second = oldView()
check("0.3 still runs afterwards", second.ok, second.errors)
check("0.3 has every conversation it had", JSON.stringify(second.ids) === JSON.stringify(first.ids) && JSON.stringify(during.ids) === JSON.stringify(first.ids), `${first.ids.length} before, ${second.ids.length} after`)
check("0.3 can still open one in full", second.exported === first.exported && first.exported > 0, `${first.exported} bytes before, ${second.exported} after`)
check("0.3 sees its keys, and the one added here", second.credentials === first.credentials + 1, `${first.credentials} before, ${second.credentials} after`)
check("0.3 lists its models", second.models >= first.models && first.models > 0, `${first.models} before, ${second.models} after`)

const authAfter = JSON.parse(fs.readFileSync(path.join(copy.data, "auth.json"), "utf8")) as Record<string, unknown>
check("every key and sign-in 0.3 stored is byte for byte what it was", Object.keys(authBefore).every((name) => JSON.stringify(authAfter[name]) === JSON.stringify(authBefore[name])), Object.keys(authBefore).length + " entries")
check("0.3's own settings files are untouched", fixed.every((file) => sha(file) === hashes[file]), fixed.map((file) => path.basename(file)).join(", "))
const db = new Database(path.join(copy.data, "codegoblin.db"), { readonly: true })
const integrity = (db.query("pragma integrity_check").get() as { integrity_check: string }).integrity_check
db.close()
check("0.3's database passes its integrity check", integrity === "ok", integrity)

// The copy holds a few hundred megabytes of database. It goes to the Recycle Bin, never a permanent delete.
let left = box
if (!failures && process.platform === "win32" && fs.existsSync(path.join(box, "data")) && box.startsWith(os.tmpdir())) {
  const bin = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CG_ROLLBACK_BOX, 'OnlyErrorDialogs', 'SendToRecycleBin')"], { env: { ...process.env, CG_ROLLBACK_BOX: box } })
  if (bin.exitCode === 0) left = ""
}
console.log((failures ? `\n${failures} failed.` : "\nAll passed.") + (left ? ` Profile copy left at ${left}` : ""))
process.exit(failures ? 1 : 0)
