import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { cancelDownload, currentDownload, downloadModel, LOCAL_CATALOG, type CatalogEntry } from "../src/core/local-downloads"

const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251))
const entry: CatalogEntry = {
  id: "fixture", label: "Fixture model", repo: "Qwen/Fixture-GGUF", file: "Fixture-Q8_0.gguf",
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), about: "test",
}
const fresh = () => fs.mkdtempSync(path.join(process.env.CODEGOBLIN_TEST_SANDBOX!, "downloads-"))

/** Stands in for Hugging Face: the resolve URL redirects to its CDN, which honours Range. */
function hub(options: { body?: Buffer; ignoreRange?: boolean; redirectTo?: string; stall?: boolean } = {}) {
  const seen: { url: string; range?: string }[] = []
  const fetch = async (url: URL, init: RequestInit) => {
    const range = (init.headers as Record<string, string>)?.range
    seen.push({ url: url.href, range })
    if (url.hostname === "huggingface.co") return new Response(null, { status: 302, headers: { location: options.redirectTo ?? "https://cdn-lfs.hf.co/blob/fixture" } })
    const body = options.body ?? bytes
    const from = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    const slice = body.subarray(from)
    const stream = new ReadableStream({
      start(controller) {
        for (let at = 0; at < slice.length; at += 16_384) controller.enqueue(slice.subarray(at, at + 16_384))
        if (!options.stall) controller.close()
      },
    })
    return new Response(stream, { status: from ? 206 : 200 })
  }
  return { fetch, seen }
}

test("downloads through the CDN redirect, reports progress, and keeps only a verified file", async () => {
  const dir = fresh()
  const server = hub()
  const reports: number[] = []
  const file = await downloadModel(entry, { dir, fetch: server.fetch, headroom: 0, onProgress: (progress) => reports.push(progress.received) })
  expect(file).toBe(path.join(dir, entry.file))
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  expect(fs.existsSync(file + ".part")).toBe(false)
  expect(reports.at(-1)).toBe(bytes.length)
  expect(server.seen.map((hop) => new URL(hop.url).hostname)).toEqual(["huggingface.co", "cdn-lfs.hf.co"])
  expect(currentDownload()).toBeUndefined()
})

test("a redirect off Hugging Face is refused before anything is written", async () => {
  const dir = fresh()
  await expect(downloadModel(entry, { dir, fetch: hub({ redirectTo: "https://downloads.example.com/x" }).fetch, headroom: 0 })).rejects.toThrow("only Hugging Face is trusted")
  await expect(downloadModel(entry, { dir, fetch: hub({ redirectTo: "http://cdn-lfs.hf.co/x" }).fetch, headroom: 0 })).rejects.toThrow("Refusing")
  expect(fs.readdirSync(dir)).toEqual([])
})

test("wrong bytes are discarded, not installed or resumed", async () => {
  const dir = fresh()
  const tampered = Buffer.from(bytes); tampered[1000] ^= 0xff
  await expect(downloadModel(entry, { dir, fetch: hub({ body: tampered }).fetch, headroom: 0 })).rejects.toThrow("did not match its pinned SHA-256")
  expect(fs.readdirSync(dir)).toEqual([])
})

test("a partial download resumes with a Range request; an ignored Range starts over", async () => {
  const dir = fresh()
  fs.writeFileSync(path.join(dir, entry.file + ".part"), bytes.subarray(0, 70_000))
  const resumed = hub()
  await downloadModel(entry, { dir, fetch: resumed.fetch, headroom: 0 })
  expect(resumed.seen.at(-1)!.range).toBe("bytes=70000-")
  expect(fs.readFileSync(path.join(dir, entry.file)).equals(bytes)).toBe(true)

  const again = fresh()
  fs.writeFileSync(path.join(again, entry.file + ".part"), bytes.subarray(0, 70_000))
  await downloadModel(entry, { dir: again, fetch: hub({ ignoreRange: true }).fetch, headroom: 0 })
  expect(fs.readFileSync(path.join(again, entry.file)).equals(bytes)).toBe(true)
})

test("a short body keeps its .part for later; cancel stops a stalled one and keeps it too", async () => {
  const dir = fresh()
  await expect(downloadModel(entry, { dir, fetch: hub({ body: bytes.subarray(0, 50_000) }).fetch, headroom: 0 })).rejects.toThrow("ended early")
  expect(fs.statSync(path.join(dir, entry.file + ".part")).size).toBe(50_000)

  const stalled = fresh()
  const pending = downloadModel(entry, { dir: stalled, fetch: hub({ stall: true }).fetch, headroom: 0 })
  await Bun.sleep(100)
  await expect(downloadModel(entry, { dir: stalled, fetch: hub().fetch, headroom: 0 })).rejects.toThrow("Already downloading")
  expect(currentDownload()?.entry.id).toBe("fixture")
  expect(cancelDownload()).toBe(true)
  await expect(pending).rejects.toBeDefined()
  expect(currentDownload()).toBeUndefined()
  expect(fs.existsSync(path.join(stalled, entry.file + ".part"))).toBe(true)
})

test("too little disk space is refused up front", async () => {
  await expect(downloadModel(entry, { dir: fresh(), fetch: hub().fetch, headroom: 1024 ** 5 })).rejects.toThrow("Not enough disk space")
})

test("every catalogue entry is an official Qwen GGUF with a full pinned hash", () => {
  for (const item of LOCAL_CATALOG) {
    expect(item.repo.startsWith("Qwen/")).toBe(true)
    expect(item.file.endsWith(".gguf")).toBe(true)
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(item.bytes).toBeGreaterThan(100_000_000)
  }
  expect(new Set(LOCAL_CATALOG.map((item) => item.id)).size).toBe(LOCAL_CATALOG.length)
})
