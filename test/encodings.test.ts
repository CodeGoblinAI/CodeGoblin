import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { History } from "../src/core/undo"
import { runTool } from "../src/core/tools"
import { decodeText, encodeText } from "../src/core/text-edit"

/**
 * Text files Windows writes in UTF-16 (Windows PowerShell 5's `>`, .reg exports, some logs) were refused as
 * binary, found by no search and changed by no edit; and undo read every snapshot as UTF-8, so it rewrote a
 * UTF-16 file as something else and damaged a binary one.
 */
const project = () => fs.mkdtempSync(path.join(os.tmpdir(), "cg-encodings-"))
const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])

test("each way a text file is stored comes back as it went in", () => {
  const text = "café\r\n日本語 \u{1F389}\r\n"
  for (const encoding of ["utf8", "utf8-bom", "utf16le", "utf16be"] as const) {
    const bytes = encodeText(text, encoding)
    expect(decodeText(bytes)).toEqual({ text, encoding })
    expect(encodeText(decodeText(bytes)!.text, decodeText(bytes)!.encoding).equals(bytes)).toBe(true)
  }
  expect(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeUndefined()
})

test("a UTF-16 file is read, searched and edited as text, and stays UTF-16", async () => {
  const root = project()
  const file = path.join(root, "build.log")
  fs.writeFileSync(file, utf16("line one\r\nerror: it failed\r\nline three\r\n"))
  expect(await runTool("read_file", { path: "build.log" }, root)).toContain("error: it failed")
  expect(await runTool("grep", { query: "it failed" }, root)).toContain("build.log:2:")
  expect(await runTool("edit_file", { path: "build.log", old_string: "line three", new_string: "line 3" }, root)).toContain("+ line 3")
  const after = fs.readFileSync(file)
  expect(after.subarray(0, 2).toString("hex")).toBe("fffe")
  expect(after.subarray(2).toString("utf16le")).toBe("line one\r\nerror: it failed\r\nline 3\r\n")
  // Rewritten whole, it keeps its encoding and its line endings.
  await runTool("write_file", { path: "build.log", content: "new\nlines\n" }, root)
  expect(fs.readFileSync(file).equals(utf16("new\r\nlines\r\n"))).toBe(true)
})

test("a UTF-8 file's byte order mark is not shown as a character, and is kept", async () => {
  const root = project()
  fs.writeFileSync(path.join(root, "a.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first line\n")]))
  expect(await runTool("read_file", { path: "a.txt" }, root)).toStartWith("first line")
  await runTool("edit_file", { path: "a.txt", old_string: "first", new_string: "1st" }, root)
  expect(fs.readFileSync(path.join(root, "a.txt")).toString("hex")).toBe("efbbbf" + Buffer.from("1st line\n").toString("hex"))
})

test("undo puts a UTF-16 file and a binary file back byte for byte", async () => {
  const root = project()
  const original = utf16("setting=été\r\n")
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80])
  fs.writeFileSync(path.join(root, "conf.reg"), original)
  fs.writeFileSync(path.join(root, "image.bin"), binary)
  // Real PNG header (no zero bytes), MP3 sync header (starts with 0xff 0xfe!), and UTF-32LE BOM are all binary, never mangled as text.
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const mp3Frame = Buffer.from([0xff, 0xfe, 0x90, 0x64, 0xd8, 0x00, 0x11])
  const utf32le = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])
  expect(decodeText(pngHeader)).toBeUndefined()
  expect(decodeText(mp3Frame)).toBeUndefined()
  expect(decodeText(utf32le)).toBeUndefined()
  fs.writeFileSync(path.join(root, "real.png"), pngHeader)
  fs.writeFileSync(path.join(root, "clip.mp3"), mp3Frame)
  const history = new History()
  history.begin("change all")
  await history.record(root, "conf.reg")
  await history.record(root, "image.bin")
  await history.record(root, "real.png")
  await history.record(root, "clip.mp3")
  await runTool("edit_file", { path: "conf.reg", old_string: "été", new_string: "winter" }, root)
  fs.writeFileSync(path.join(root, "image.bin"), "overwritten as text")
  fs.writeFileSync(path.join(root, "real.png"), "overwritten png")
  fs.writeFileSync(path.join(root, "clip.mp3"), "overwritten mp3")
  history.commit(root)
  await history.undo(root)
  expect(fs.readFileSync(path.join(root, "conf.reg")).equals(original)).toBe(true)
  expect(fs.readFileSync(path.join(root, "image.bin")).equals(binary)).toBe(true)
  expect(fs.readFileSync(path.join(root, "real.png")).equals(pngHeader)).toBe(true)
  expect(fs.readFileSync(path.join(root, "clip.mp3")).equals(mp3Frame)).toBe(true)
})
