import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { installedModels, ownedModelsDir } from "./local-runtime"

/**
 * Models CG-Next offers to download, each pinned to the exact file.
 *
 * Official Qwen repositories only, with the size and SHA-256 the Hugging Face
 * API reports for that file (read 2026-10-30). A download that does not match
 * both is thrown away rather than offered as a model: a GGUF is executable
 * input to a native engine, and "the right name" is not "the right bytes".
 */
export type CatalogEntry = {
  id: string
  label: string
  repo: string
  file: string
  bytes: number
  sha256: string
  about: string
}

export const LOCAL_CATALOG: CatalogEntry[] = [
  { id: "qwen3-0.6b", label: "Qwen3 0.6B (Q8_0)", repo: "Qwen/Qwen3-0.6B-GGUF", file: "Qwen3-0.6B-Q8_0.gguf", bytes: 639_446_688,
    sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", about: "tiny; chat and smoke tests" },
  { id: "qwen3-1.7b", label: "Qwen3 1.7B (Q8_0)", repo: "Qwen/Qwen3-1.7B-GGUF", file: "Qwen3-1.7B-Q8_0.gguf", bytes: 1_834_426_016,
    sha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", about: "fast chat; loops with tools" },
  { id: "qwen3-4b", label: "Qwen3 4B (Q4_K_M)", repo: "Qwen/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf", bytes: 2_497_280_256,
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5", about: "fits 8 GB; tools unreliable" },
  { id: "qwen3-8b", label: "Qwen3 8B (Q4_K_M)", repo: "Qwen/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", bytes: 5_027_783_488,
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785", about: "best local coder here; 5/5 with tools" },
]

export const sourceUrl = (entry: CatalogEntry) => `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`

/** Hugging Face serves LFS files from its CDN; a redirect anywhere else is refused. */
const TRUSTED = (host: string) => host === "huggingface.co" || host.endsWith(".huggingface.co") || host.endsWith(".hf.co")

export const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GB"
/** Progress in MB until there is a whole gigabyte of it: "0.0 GB" for the first minutes read as stuck. */
const amount = (bytes: number) => bytes < 1024 ** 3 ? Math.floor(bytes / 1024 ** 2) + " MB" : gb(bytes)

export type Progress = { entry: CatalogEntry; received: number; total: number; bytesPerSecond: number; startedAt: number; resumedFrom: number }

/** Installed means a file of the pinned name and size is in some model folder. */
export function isInstalled(entry: CatalogEntry): boolean {
  return installedModels({ fresh: true }).some((model) => path.basename(model.path) === entry.file && model.sizeBytes === entry.bytes)
}

let active: { progress: Progress; stop: AbortController; done: Promise<string> } | undefined
let last: { id: string; ok: boolean; message: string; at: number } | undefined

/** The download in progress, if any - one at a time, so two never fight for the disk or the link. */
export const currentDownload = () => active?.progress
/** How the most recent download ended, for a surface that was not watching when it did. */
export const lastDownload = () => last

export function progressText(progress: Progress): string {
  const percent = Math.floor((progress.received / progress.total) * 100)
  const speed = progress.bytesPerSecond ? ` · ${(progress.bytesPerSecond / 1024 ** 2).toFixed(0)} MB/s` : ""
  const left = progress.bytesPerSecond ? ` · ~${Math.max(1, Math.round((progress.total - progress.received) / progress.bytesPerSecond / 60))} min left` : ""
  return `downloading ${progress.entry.label}: ${percent}% · ${amount(progress.received)} of ${gb(progress.total)}${speed}${left} · /local cancel stops it`
}

function ended(entry: CatalogEntry, error?: unknown): string {
  if (!error) return `Downloaded and verified ${entry.file} (${gb(entry.bytes)}, SHA-256 matches). Pick it under Local models.`
  const message = error instanceof Error ? error.message : String(error)
  return /cancel|abort/i.test(message) ? `Stopped downloading ${entry.label}; the partial file is kept and /local pull resumes it.` : message
}

export function cancelDownload(): boolean {
  if (!active) return false
  active.stop.abort(new Error("download cancelled"))
  return true
}

export type DownloadOptions = {
  signal?: AbortSignal
  onProgress?: (progress: Progress) => void
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
  dir?: string
  /** Bytes the disk must keep free beyond the file itself. */
  headroom?: number
}

/**
 * Download one catalogue model into CG-Next's own models folder.
 *
 * Written to <file>.part and renamed only after the size and SHA-256 match,
 * so a model under its real name is always a whole, verified one. A stopped
 * download keeps its .part and resumes from it next time; a failed check
 * removes it, since resuming bad bytes cannot produce good ones.
 */
export function downloadModel(entry: CatalogEntry, options: DownloadOptions = {}): Promise<string> {
  if (active) return Promise.reject(new Error(`Already downloading ${active.progress.entry.label}; /local cancel stops it.`))
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  const progress: Progress = { entry, received: 0, total: entry.bytes, bytesPerSecond: 0, startedAt: Date.now(), resumedFrom: 0 }
  const done = run(entry, progress, { ...options, signal })
    .then((file) => { last = { id: entry.id, ok: true, message: ended(entry), at: Date.now() }; return file })
    .catch((error: unknown) => { last = { id: entry.id, ok: false, message: ended(entry, error), at: Date.now() }; throw new Error(last.message, { cause: error }) })
    .finally(() => { if (active?.progress === progress) active = undefined })
  active = { progress, stop, done }
  return done
}

async function run(entry: CatalogEntry, progress: Progress, options: DownloadOptions & { signal: AbortSignal }): Promise<string> {
  const dir = options.dir ?? ownedModelsDir()
  const final = path.join(dir, entry.file)
  const part = final + ".part"
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(final) && fs.statSync(final).size === entry.bytes) return final

  // Resume: what is already on disk is hashed first, so the digest covers the whole file.
  const hash = createHash("sha256")
  let have = 0
  if (fs.existsSync(part)) {
    have = fs.statSync(part).size
    if (have > entry.bytes) { fs.rmSync(part); have = 0 }
    else await new Promise<void>((resolve, reject) => {
      fs.createReadStream(part).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject)
    })
  }
  const free = freeBytes(dir)
  const needed = entry.bytes - have + (options.headroom ?? 1024 ** 3)
  if (free !== undefined && free < needed) {
    throw new Error(`Not enough disk space for ${entry.label}: needs ${gb(needed)} free in ${dir}, ${gb(free)} available.`)
  }

  const response = await fetchTrusted(sourceUrl(entry), have, options)
  if (!response.ok || !response.body) throw new Error(`Download of ${entry.label} failed: HTTP ${response.status}.`)
  // A 200 to a ranged request is the whole file again: start the .part over.
  if (have && response.status !== 206) return finish(response, 0, createHash("sha256"))
  return finish(response, have, hash)

  async function finish(body: Response, from: number, digest: ReturnType<typeof createHash>): Promise<string> {
    progress.resumedFrom = from
    progress.received = from
    const file = await fs.promises.open(part, from ? "a" : "w")
    const started = Date.now()
    let lastReport = 0
    const reader = body.body!.getReader()
    // Cancel reaches a stalled read too, not just the next chunk.
    const cancel = () => { void reader.cancel(options.signal.reason).catch(() => {}) }
    options.signal.addEventListener("abort", cancel, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        options.signal.throwIfAborted()
        if (done) break
        digest.update(value)
        await file.write(value)
        progress.received += value.byteLength
        if (progress.received > entry.bytes) throw new Error(`${entry.label} is larger than its pinned size; refusing it.`)
        const now = Date.now()
        if (now - lastReport > 250) {
          lastReport = now
          progress.bytesPerSecond = (progress.received - from) / Math.max(0.001, (now - started) / 1000)
          options.onProgress?.({ ...progress })
        }
      }
    } finally {
      options.signal.removeEventListener("abort", cancel)
      await file.close()
    }
    options.onProgress?.({ ...progress })
    if (progress.received !== entry.bytes) throw new Error(`${entry.label} ended early (${gb(progress.received)} of ${gb(entry.bytes)}); /local pull ${entry.id} resumes it.`)
    const sha = digest.digest("hex")
    if (sha !== entry.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error(`${entry.label} did not match its pinned SHA-256 and was discarded (got ${sha.slice(0, 12)}…, expected ${entry.sha256.slice(0, 12)}…).`)
    }
    fs.renameSync(part, final)
    installedModels({ fresh: true })
    return final
  }
}

/** Follows redirects by hand so each hop can be checked against the trusted hosts. */
async function fetchTrusted(start: string, from: number, options: DownloadOptions & { signal: AbortSignal }): Promise<Response> {
  const get = options.fetch ?? fetch
  let url = new URL(start)
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== "https:" || !TRUSTED(url.hostname)) throw new Error(`Refusing to download from ${url.host}: only Hugging Face is trusted for models.`)
    const response = await get(url, { redirect: "manual", signal: options.signal, headers: from ? { range: `bytes=${from}-` } : {} })
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location")
      if (!next) throw new Error(`Download redirect without a location (HTTP ${response.status}).`)
      await response.body?.cancel()
      url = new URL(next, url)
      continue
    }
    return response
  }
  throw new Error("Too many redirects downloading the model.")
}

function freeBytes(dir: string): number | undefined {
  try {
    const stats = fs.statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch { return undefined }
}
