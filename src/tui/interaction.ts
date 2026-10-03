import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export function ctrlCAction(input: { selected: boolean; busy: boolean; draft: boolean; secret: boolean }) {
  if (input.selected && !input.secret) return "copy"
  if (input.busy) return "stop"
  if (input.draft) return "clear"
  return "quit"
}

export async function copyText(text: string) {
  const command = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"]
    : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
    const timer = setTimeout(() => { child.kill(); reject(new Error("Clipboard timed out")) }, 3000)
    child.on("error", reject)
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Clipboard unavailable; use your terminal's copy shortcut")) })
    child.stdin.on("error", reject)
    child.stdin.end(text, "utf8")
  })
}

export function dialogRowAt(input: { col: number; row: number; cols: number; rows: number; width: number; height: number; boxHeight: number; first: number }) {
  const left = Math.max(0, Math.floor((input.cols - input.width) / 2))
  const top = Math.max(0, Math.min(Math.floor(input.rows / 4), Math.max(0, input.rows - input.boxHeight - 6)))
  const offset = input.row - 1 - top - 3
  if (input.col <= left || input.col > left + input.width || offset < 0 || offset >= input.height) return undefined
  return input.first + offset
}

/**
 * Whether a click landed anywhere on the dialog box - title, border, a
 * heading - rather than outside it. Same geometry as dialogRowAt; only a
 * click outside the box should close it.
 */
export function insideDialog(input: { col: number; row: number; cols: number; rows: number; width: number; boxHeight: number }) {
  const left = Math.max(0, Math.floor((input.cols - input.width) / 2))
  const top = Math.max(0, Math.min(Math.floor(input.rows / 4), Math.max(0, input.rows - input.boxHeight - 6)))
  return input.col > left && input.col <= left + input.width && input.row > top && input.row <= top + input.boxHeight
}

/** Clipboard bitmaps are capped like attached images: providers reject walls of JSON, not kindly. */
const MAX_CLIPBOARD_BYTES = 5_000_000

/**
 * A picture from the OS clipboard, for models that can be shown one.
 *
 * Terminals cannot deliver a copied picture as keystrokes, so pasting one
 * does nothing unless the app goes and reads it. Windows reads it with
 * PowerShell; other platforms try their usual tools and say which is
 * missing. Anything that is not a picture is "copy an image first".
 */
export async function readClipboardImage(): Promise<{ name: string; dataUrl: string }> {
  const stamp = Date.now().toString(36)
  if (process.platform === "win32") {
    const file = path.join(os.tmpdir(), `cg-next-clip-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`)
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          `$img = Get-Clipboard -Format Image; if ($null -eq $img) { exit 2 }; $img.Save('${file}', 'Png')`],
        { windowsHide: true, stdio: "ignore" },
      )
      child.on("error", () => resolve(1))
      child.on("close", (exited) => resolve(exited ?? 1))
    })
    if (code === 2) throw new Error("no image on the clipboard - copy one first")
    if (code !== 0) throw new Error("could not read the clipboard")
    try {
      const bytes = await fs.readFile(file)
      if (bytes.length > MAX_CLIPBOARD_BYTES) throw new Error("that picture is too large to send")
      return { name: `clipboard-${stamp}.png`, dataUrl: "data:image/png;base64," + bytes.toString("base64") }
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  }
  const helper = process.platform === "darwin" ? "pngpaste -" : "xclip -selection clipboard -t image/png -o"
  try {
    const child = spawn(helper.split(" ")[0]!, helper.split(" ").slice(1), { stdio: ["ignore", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    const bytes: Buffer = await new Promise((resolve, reject) => {
      child.stdout.on("data", (part: Buffer) => chunks.push(part))
      child.on("error", reject)
      child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(String(code)))))
    })
    if (!bytes.length || bytes.length > MAX_CLIPBOARD_BYTES) throw new Error("no usable image")
    return { name: `clipboard-${stamp}.png`, dataUrl: "data:image/png;base64," + bytes.toString("base64") }
  } catch {
    throw new Error(`no image on the clipboard - install ${process.platform === "darwin" ? "pngpaste" : "xclip"} for clipboard pictures`)
  }
}
