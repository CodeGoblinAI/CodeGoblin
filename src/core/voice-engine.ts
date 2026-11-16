import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { Global } from "../platform/paths"
import { isCompiled } from "../platform/self"

/**
 * The speech engine for voice input (sherpa-onnx), and how the built program gets it.
 *
 * It is native code: a library per system that cannot be carried inside one program file. From a source
 * checkout it is simply the installed package. The built program has none, so the first voice setup fetches
 * it - two packages from the npm registry, about 10 MB - beside the speech model it already downloads.
 *
 * Nothing is run to install it: the files are unpacked here, not by a package manager, so no install script
 * ever executes. Each download is checked against a SHA-512 fixed in this file before a byte is unpacked; a
 * different file, whoever serves it, is thrown away. Only regular files are written, only under the engine's
 * own folder.
 */
export const ENGINE_VERSION = "2.0.1"

type Package = { name: string; bytes: number; integrity: string }
/** The part that is the same everywhere: the JavaScript that loads the library. */
const LOADER: Package = { name: "sherpa-onnx-node", bytes: 12_709, integrity: "sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==" }
/** The library, by Node's platform-arch. sherpa names Windows "win", and so does its loader when it looks for this. */
const LIBRARIES: Record<string, Package> = {
  "win32-x64": { name: "sherpa-onnx-win-x64", bytes: 8_779_375, integrity: "sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==" },
  "win32-arm64": { name: "sherpa-onnx-win-arm64", bytes: 8_486_399, integrity: "sha512-Mb9iqy2Zp7GC5a99dk5E8EQJsEBnapf+IcwHLVCgtIf5mxYHO9Q8YptnAoOHZOD0Zi+R+MblFyG9qv0Q6tin4Q==" },
  "linux-x64": { name: "sherpa-onnx-linux-x64", bytes: 11_005_484, integrity: "sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==" },
  "linux-arm64": { name: "sherpa-onnx-linux-arm64", bytes: 13_822_449, integrity: "sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==" },
  "darwin-arm64": { name: "sherpa-onnx-darwin-arm64", bytes: 10_013_200, integrity: "sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==" },
}

const library = (platform = process.platform, arch = process.arch): Package | undefined => LIBRARIES[platform + "-" + arch]

/** Where a fetched engine lives. A new engine version gets a new folder, so an old one is never half replaced. */
export const engineDir = () => process.env.CG_VOICE_ENGINE_DIR || path.join(Global.Path.data, "voice", "engine-" + ENGINE_VERSION)

const fetchedEntry = () => path.join(engineDir(), "node_modules", LOADER.name, "sherpa-onnx.js")

/**
 * The file to load the engine from, or nothing when it is not on this machine: the installed package (a
 * source checkout), else one fetched earlier. CG_VOICE_ENGINE_FETCHED=1 ignores the installed package, to
 * try the fetched path from source.
 */
export function engineEntry(): string | undefined {
  if (!isCompiled && process.env.CG_VOICE_ENGINE_FETCHED !== "1") {
    try { return createRequire(import.meta.url).resolve("sherpa-onnx-node") } catch {}
  }
  const lib = library()
  if (!lib) return undefined
  return fs.existsSync(fetchedEntry()) && fs.existsSync(path.join(engineDir(), "node_modules", lib.name, "sherpa-onnx.node")) ? fetchedEntry() : undefined
}

/** Whether there is an engine for this computer to fetch. */
export const engineFetchable = (platform = process.platform, arch = process.arch) => Boolean(library(platform, arch))

/** Bytes a fetch would download, for progress and for telling the person first. */
export const engineBytes = (platform = process.platform, arch = process.arch) => (library(platform, arch)?.bytes ?? 0) + LOADER.bytes

export type TarFile = { path: string; data: Uint8Array }

/**
 * The regular files in a tar archive. Anything else in it - links, devices, directories - is not returned,
 * and a name that is absolute or climbs out with ".." is refused outright rather than cleaned up.
 */
export function untar(archive: Uint8Array): TarFile[] {
  const files: TarFile[] = []
  const text = (from: number, length: number) => {
    let end = from
    while (end < from + length && archive[end] !== 0) end++
    return Buffer.from(archive.subarray(from, end)).toString("utf8")
  }
  let longName: string | undefined
  for (let at = 0; at + 512 <= archive.length;) {
    if (archive.subarray(at, at + 512).every((byte) => byte === 0)) break
    const size = parseInt(text(at + 124, 12).trim() || "0", 8)
    if (!Number.isFinite(size) || size < 0 || at + 512 + size > archive.length) throw new Error("the archive is damaged")
    const type = String.fromCharCode(archive[at + 156] || 48)
    const body = archive.subarray(at + 512, at + 512 + size)
    const prefix = text(at + 345, 155)
    const name = longName ?? (prefix ? prefix + "/" : "") + text(at, 100)
    longName = undefined
    if (type === "L") longName = Buffer.from(body).toString("utf8").replace(/\0+$/, "")
    else if (type === "x") {
      // A pax header: "<length> path=<name>\n" carries a name too long for the plain field.
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.from(body).toString("utf8"))
      if (found) longName = found[1]
    } else if (type === "0" || type === "\0") {
      const parts = name.split("/")
      if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\") || parts.some((part) => part === ".." || part === "")) throw new Error("the archive holds a file outside its own folder: " + name)
      files.push({ path: name, data: body })
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function download(pkg: Package, options: { fetch: typeof fetch; signal?: AbortSignal; onBytes: (count: number) => void }): Promise<Uint8Array> {
  const registry = process.env.CODEGOBLIN_REGISTRY_URL || "https://registry.npmjs.org"
  const response = await options.fetch(`${registry}/${pkg.name}/-/${pkg.name}-${ENGINE_VERSION}.tgz`, { signal: options.signal, redirect: "error" })
  if (!response.ok || !response.body) throw new Error(`The speech engine could not be downloaded (${pkg.name}: the registry answered ${response.status}).`)
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.length
    // Twice the size it should be is not a slow connection, it is a different file.
    if (received > pkg.bytes * 2 + 1_000_000) throw new Error("The speech engine download was larger than it should be, and was discarded.")
    chunks.push(chunk)
    options.onBytes(chunk.length)
  }
  const whole = Buffer.concat(chunks)
  if ("sha512-" + createHash("sha512").update(whole).digest("base64") !== pkg.integrity) throw new Error(`The speech engine download did not match its checksum (${pkg.name}), and was discarded. Nothing was installed.`)
  return whole
}

/**
 * Fetches the engine for this computer and unpacks it. Both packages are checked before either is written,
 * and they are written to a folder beside the real one and moved into place at the end, so a stopped or
 * failed fetch leaves no half engine behind.
 */
export async function installEngine(options: { fetch?: typeof fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}): Promise<void> {
  const lib = library()
  if (!lib) throw new Error(`There is no speech engine for this computer (${process.platform} ${process.arch}).`)
  const total = lib.bytes + LOADER.bytes
  let received = 0
  const fetcher = options.fetch ?? fetch
  const onBytes = (count: number) => { received += count; options.onProgress?.(Math.min(received, total), total) }
  const packages: [Package, Uint8Array][] = []
  for (const pkg of [LOADER, lib]) packages.push([pkg, await download(pkg, { fetch: fetcher, signal: options.signal, onBytes })])

  const dir = engineDir()
  const staging = dir + ".part-" + process.pid
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  for (const [pkg, archive] of packages) {
    const root = path.join(staging, "node_modules", pkg.name)
    for (const file of untar(zlib.gunzipSync(archive, { maxOutputLength: 400 * 1024 * 1024 }))) {
      // npm puts a package's files under "package/".
      const inside = file.path.split("/").slice(1)
      if (!inside.length) continue
      const target = path.join(root, ...inside)
      if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) throw new Error("the archive holds a file outside its own folder: " + file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.data)
    }
  }
  if (!fs.existsSync(path.join(staging, "node_modules", lib.name, "sherpa-onnx.node"))) throw new Error("The speech engine package did not contain the engine. Nothing was installed.")
  // An earlier attempt may have left a folder that never became usable; it is moved aside, not deleted.
  if (fs.existsSync(dir)) fs.renameSync(dir, dir + ".old-" + Date.now())
  fs.renameSync(staging, dir)
}
