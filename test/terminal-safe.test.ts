import { expect, test } from "bun:test"
import { frameSafe, visibleCall, visibleControls } from "../src/core/terminal-safe"
import { askedFor } from "../src/core/permission"

/**
 * Text from a model, a file, a command or a paste reached the terminal as it came, and a terminal obeys
 * what it is sent: OSC 52 sets the clipboard, OSC 0 the window title, SGR 8 hides text.
 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const CLIPBOARD = ESC + "]52;c;" + Buffer.from("rm -rf ~").toString("base64") + BEL
const TITLE = ESC + "]0;owned" + ESC + "\\"
const SHOWN = String.fromCharCode(0x241b)

test("arriving text: every control is shown or dropped, nothing is left to obey", () => {
  const shown = visibleControls("before " + CLIPBOARD + TITLE + ESC + "[2J" + ESC + "[8mhidden" + String.fromCharCode(8) + "\r after")
  expect(shown).not.toContain(ESC)
  expect(shown).not.toContain(BEL)
  expect(shown).not.toContain("\r")
  expect(shown).toContain(SHOWN + "]52;c;")
  // What a hide code would have hidden is on the screen.
  expect(shown).toContain(SHOWN + "[8mhidden")
  // Layout survives; plain text and other scripts are untouched, and come back as the same string.
  expect(visibleControls("a\tb\nc")).toBe("a\tb\nc")
  const plain = "日本語 🎉 é zero\u200bwidth"
  expect(visibleControls(plain)).toBe(plain)
  // The 8-bit escape is an escape too.
  expect(visibleControls("x" + String.fromCharCode(0x9b) + "2Jy")).toBe("x" + SHOWN + "2Jy")
})

test("what a call asks to run cannot be partly hidden or drawn in another order", () => {
  // A clipboard code inside a command: on a frame its contents would have been removed, so the approval box
  // showed "echo hi" for a command that also deletes. It is all on screen, shown, not obeyed.
  const command = "echo hi " + ESC + "]0;; rm -rf ~ " + BEL
  const shown = askedFor("shell", JSON.stringify({ command }))
  expect(shown).toContain("rm -rf ~")
  expect(frameSafe(shown)).toContain("rm -rf ~")
  // A right-to-left override is named, not obeyed.
  expect(askedFor("shell", JSON.stringify({ command: "ls #\u202e txt.exe" }))).toBe("ls #<U+202E> txt.exe")
  expect(askedFor("read_file", JSON.stringify({ path: "a\u2066b\u2069.txt" }))).toBe("a<U+2066>b<U+2069>.txt")
  // Right-to-left writing itself is text, and stays.
  expect(visibleCall("echo שלום")).toBe("echo שלום")
})

test("a finished line keeps the app's colours and loses everything else", () => {
  const colour = ESC + "[38;2;10;200;30m"
  expect(frameSafe(colour + "green" + ESC + "[0m")).toBe(colour + "green" + ESC + "[0m")
  // Clipboard and title codes go whole, with their contents, whichever terminator they use.
  expect(frameSafe("a" + CLIPBOARD + "b" + TITLE + "c")).toBe("abc")
  // An unterminated one takes the rest of the line rather than leaking it as a code.
  expect(frameSafe("a" + ESC + "]52;c;abc")).toBe("a")
  // Cursor moves, screen clears, private modes and two-byte escapes go.
  expect(frameSafe("a" + ESC + "[2J" + ESC + "[10;5H" + ESC + "[?1049l" + ESC + "cb")).toBe("ab")
  // Conceal is taken out of a style code, and an extended colour's own 8 is left alone.
  expect(frameSafe(ESC + "[1;8mx")).toBe(ESC + "[1mx")
  expect(frameSafe("a" + ESC + "[8mx")).toBe("ax")
  expect(frameSafe(ESC + "[mx")).toBe(ESC + "[mx")
  expect(frameSafe(ESC + "[38;5;8;8mx")).toBe(ESC + "[38;5;8mx")
  expect(frameSafe(ESC + "[38;2;8;8;8mx")).toBe(ESC + "[38;2;8;8;8mx")
  // Other control characters go; text is never changed.
  expect(frameSafe("a" + BEL + "b" + String.fromCharCode(8) + "c")).toBe("abc")
  expect(frameSafe("plain line")).toBe("plain line")
})
