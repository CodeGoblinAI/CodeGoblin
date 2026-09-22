import { spawn } from "node:child_process"

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
