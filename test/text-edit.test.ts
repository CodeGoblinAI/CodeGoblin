import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { lineEndingOf, replaceOnce, withLineEnding } from "../src/core/text-edit"
import { plainOutput, runTool, shellEnvironment, stripColour } from "../src/core/tools"

const LF = String.fromCharCode(10), CR = String.fromCharCode(13), CRLF = CR + LF, TAB = String.fromCharCode(9), ESC = String.fromCharCode(27)
const windowsFile = ["function add(a, b) {", "  return a + b", "}", "", "function sub(a, b) {", "  return a - b", "}", ""].join(CRLF)
const mixed = (text: string) => text.split(CRLF).join("").includes(LF)
const text = (result: ReturnType<typeof replaceOnce>) => ("text" in result ? result.text : "ERROR " + result.error)

test("which line ending a file uses", () => {
  expect(lineEndingOf(windowsFile)).toBe(CRLF)
  expect(lineEndingOf("a" + LF + "b" + LF)).toBe(LF)
  expect(lineEndingOf("one line")).toBe(LF)
  // Mostly Windows, with one stray line: still a Windows file.
  expect(lineEndingOf("a" + CRLF + "b" + CRLF + "c" + LF)).toBe(CRLF)
  expect(withLineEnding("a" + CRLF + "b" + LF + "c", CRLF)).toBe("a" + CRLF + "b" + CRLF + "c")
})

test("a multi-line edit written with plain newlines lands in a file with Windows line endings, which keeps them", () => {
  const edited = text(replaceOnce(windowsFile, "function add(a, b) {" + LF + "  return a + b" + LF + "}", "function add(a, b) {" + LF + "  return b + a" + LF + "}", "x.js"))
  expect(edited).toContain("return b + a")
  expect(mixed(edited)).toBe(false)
  expect(edited.split(CRLF).length).toBe(windowsFile.split(CRLF).length)
  // New lines added by the edit get the file's endings too.
  const longer = text(replaceOnce(windowsFile, "  return a - b", "  const d = a - b" + LF + "  return d", "x.js"))
  expect(longer).toContain("  const d = a - b" + CRLF + "  return d" + CRLF + "}")
  expect(mixed(longer)).toBe(false)
})

test("a file with plain newlines is left with plain newlines", () => {
  const unix = withLineEnding(windowsFile, LF)
  const edited = text(replaceOnce(unix, "  return a + b", "  return b + a", "x.js"))
  expect(edited.includes(CR)).toBe(false)
  expect(edited).toContain("return b + a")
})

test("spaces at the ends of lines do not hide the text; the file's own are not what is matched on", () => {
  const trailing = "def f():   " + LF + "    return 1  " + LF + "print(f())" + LF
  const result = replaceOnce(trailing, "def f():" + LF + "    return 1", "def f():" + LF + "    return 2", "x.py")
  expect(text(result)).toBe("def f():" + LF + "    return 2" + LF + "print(f())" + LF)
  expect("note" in result && result.note).toContain("ignoring spaces at the ends of lines")
  // The same in a Windows file, at its very end.
  const windowsTrailing = "a = 1  " + CRLF + "b = 2 " + CRLF
  expect(text(replaceOnce(windowsTrailing, "a = 1" + LF + "b = 2", "a = 1" + LF + "b = 3", "x.py"))).toBe("a = 1" + CRLF + "b = 3" + CRLF)
})

test("indentation is never guessed at: different spacing is refused, and said to be that", () => {
  const tabbed = "{" + LF + TAB + '"name": "x",' + LF + TAB + '"version": "1.0.0"' + LF + "}" + LF
  const result = replaceOnce(tabbed, '  "name": "x",', '  "name": "y",', "p.json")
  expect("error" in result && result.error).toBe("error: old_string is in p.json but not with this spacing - the file indents with tabs. Copy the lines exactly as read_file shows them.")
  expect("error" in replaceOnce(tabbed, "nothing like this", "x", "p.json") && (replaceOnce(tabbed, "nothing like this", "x", "p.json") as { error: string }).error).toBe("error: old_string not found in p.json")
})

test("text that is there more than once is still refused, however it was found", () => {
  const twice = "x = 1" + CRLF + "y = 2" + CRLF + "x = 1" + CRLF + "y = 2" + CRLF
  expect((replaceOnce(twice, "x = 1", "x = 9", "a.py") as { error: string }).error).toContain("appears 2 times")
  expect((replaceOnce(twice, "x = 1" + LF + "y = 2", "z", "a.py") as { error: string }).error).toContain("appears 2 times")
  expect((replaceOnce("a  " + LF + "b" + LF + "a " + LF + "b" + LF, "a" + LF + "b", "z", "a.py") as { error: string }).error).toContain("appears 2 times")
  expect((replaceOnce("abc", "", "z", "a.py") as { error: string }).error).toContain("empty")
})

test("the tools themselves: edit, patch and rewrite all keep a Windows file a Windows file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-crlf-"))
  const file = path.join(root, "crlf.js")
  fs.writeFileSync(file, windowsFile)
  const read = () => fs.readFileSync(file, "utf8")

  expect(await runTool("edit_file", { path: "crlf.js", old_string: "function add(a, b) {" + LF + "  return a + b" + LF + "}", new_string: "function add(a, b) {" + LF + "  return b + a" + LF + "}" }, root)).toContain("+ ")
  expect(read()).toContain("return b + a")
  expect(mixed(read())).toBe(false)

  expect(await runTool("apply_patch", { patch: ["*** Begin Patch", "*** Update File: crlf.js", "@@", " function sub(a, b) {", "-  return a - b", "+  return b - a", " }", "*** End Patch"].join(LF) }, root)).toContain("crlf.js")
  expect(read()).toContain("return b - a")
  expect(mixed(read())).toBe(false)

  await runTool("write_file", { path: "crlf.js", content: "const a = 1" + LF + "const b = 2" + LF }, root)
  expect(read()).toBe("const a = 1" + CRLF + "const b = 2" + CRLF)
  // A new file is written as given.
  await runTool("write_file", { path: "new.js", content: "const a = 1" + LF }, root)
  expect(fs.readFileSync(path.join(root, "new.js"), "utf8")).toBe("const a = 1" + LF)
})

test("a command's output is text to read: no colour codes, and a redrawn line as it last looked", () => {
  expect(stripColour(ESC + "[31mred" + ESC + "[0m plain " + ESC + "[1;32mbold green" + ESC + "[m")).toBe("red plain bold green")
  expect(stripColour(ESC + "]0;window title" + String.fromCharCode(7) + "after" + ESC + "[2K" + ESC + "[1A")).toBe("after")
  expect(plainOutput("progress 0%" + CR + "progress 50%" + CR + "progress 100%" + LF + "done" + LF)).toBe("progress 100%" + LF + "done" + LF)
  // Windows line endings are not redraws.
  expect(plainOutput("one" + CRLF + "two" + CRLF)).toBe("one" + LF + "two" + LF)
  expect(plainOutput("nothing special")).toBe("nothing special")
})

test("git is asked to print file names as they are", () => {
  const env = shellEnvironment({ PATH: "x" })
  expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["1", "core.quotepath", "off"])
  // Added after whatever was already being passed the same way, not over it.
  const more = shellEnvironment({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" })
  expect([more.GIT_CONFIG_COUNT, more.GIT_CONFIG_KEY_0, more.GIT_CONFIG_KEY_1, more.GIT_CONFIG_VALUE_1]).toEqual(["2", "user.name", "core.quotepath", "off"])
})

test("a file that is not text is said to be that, not decoded into noise", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-binary-"))
  fs.writeFileSync(path.join(root, "setup.exe"), new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0, 4, 0, 0, 0, 255, 255]))
  fs.writeFileSync(path.join(root, "notes.txt"), "plain text with an accent: caf" + String.fromCharCode(233))
  expect(await runTool("read_file", { path: "setup.exe" }, root)).toBe("error: setup.exe is not a text file (14 bytes of binary data). It cannot be read as text; use a command that understands this kind of file.")
  expect(await runTool("read_file", { path: "notes.txt" }, root)).toBe("plain text with an accent: caf" + String.fromCharCode(233))
})
