import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { engineBytes, engineEntry, engineFetchable, installEngine, untar } from "../src/core/voice-engine"

/** A tar archive from [name, content, type?] entries, the way npm's are laid out. */
function tar(entries: [string, string, string?][]): Uint8Array {
  const blocks: Buffer[] = []
  for (const [name, content, type = "0"] of entries) {
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0)
    header.write("0000644\0", 100)
    header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124)
    header.write(type, 156)
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512)
    body.write(content)
    blocks.push(header, body)
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

test("untar returns the regular files, with long names, and nothing else", () => {
  const long = "package/" + "deep/".repeat(30) + "file.js"
  const files = untar(tar([
    ["package/package.json", '{"name":"x"}'],
    ["package/lib/", "", "5"],
    ["package/link", "", "2"],
    ["././@LongLink", long + "\0", "L"],
    ["package/short", "long one"],
    ["package/empty", ""],
  ]))
  expect(files.map((file) => [file.path, Buffer.from(file.data).toString()])).toEqual([
    ["package/package.json", '{"name":"x"}'],
    [long, "long one"],
    ["package/empty", ""],
  ])
})

test("untar refuses a file that would land outside its folder, however it is spelled", () => {
  for (const name of ["../evil", "package/../../evil", "/etc/passwd", "C:/Windows/evil", "package\\..\\evil", "package//evil"]) {
    expect(() => untar(tar([[name, "x"]]))).toThrow("outside its own folder")
  }
  expect(() => untar(tar([["PaxHeader", "22 path=../../evil\n", "x"], ["package/ok", "x"]]))).toThrow("outside its own folder")
  // Cut short: refused, not half read.
  expect(() => untar(tar([["package/a", "x".repeat(2000)]]).subarray(0, 1024))).toThrow("damaged")
})

test("an engine exists for the five systems CodeGoblin is built for, and no others", () => {
  for (const [platform, arch] of [["win32", "x64"], ["win32", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"]] as const) {
    expect(engineFetchable(platform, arch)).toBe(true)
    expect(engineBytes(platform, arch)).toBeGreaterThan(8_000_000)
    expect(engineBytes(platform, arch)).toBeLessThan(15_000_000)
  }
  expect(engineFetchable("darwin", "x64")).toBe(false)
  expect(engineFetchable("freebsd", "x64")).toBe(false)
})

test("a download that is not the pinned file is thrown away: nothing is unpacked, nothing is installed", async () => {
  if (!engineFetchable()) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-engine-"))
  process.env.CG_VOICE_ENGINE_DIR = path.join(dir, "engine")
  process.env.CG_VOICE_ENGINE_FETCHED = "1"
  try {
    expect(engineEntry()).toBeUndefined()
    const asked: string[] = []
    // A well-formed package with the right names in it, from someone who is not the publisher.
    const impostor = zlib.gzipSync(tar([["package/sherpa-onnx.js", "require('child_process').exec('calc')"], ["package/sherpa-onnx.node", "MZ"]]))
    const serve = (async (url: string | URL | Request) => { asked.push(String(url)); return new Response(impostor) }) as unknown as typeof fetch
    await expect(installEngine({ fetch: serve })).rejects.toThrow("did not match its checksum")
    expect(asked[0]).toBe("https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-2.0.1.tgz")
    expect(fs.readdirSync(dir)).toEqual([])
    expect(engineEntry()).toBeUndefined()
    // The registry down, or the file missing: a sentence, and still nothing on disk.
    await expect(installEngine({ fetch: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch })).rejects.toThrow("answered 404")
    // Far more bytes than the real file has: stopped while downloading.
    const flood = (async () => new Response(new Uint8Array(40_000_000))) as unknown as typeof fetch
    await expect(installEngine({ fetch: flood })).rejects.toThrow("larger than it should be")
    expect(fs.readdirSync(dir)).toEqual([])
  } finally {
    delete process.env.CG_VOICE_ENGINE_DIR
    delete process.env.CG_VOICE_ENGINE_FETCHED
  }
})
