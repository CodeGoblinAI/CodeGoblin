export function codexLoginUrl(url: string) {
  const target = new URL(url)
  if (target.protocol !== "https:" || target.hostname !== "auth.openai.com" || target.port || target.username || target.password) throw new Error("Untrusted login URL")
  return target.href
}

/** Only validated official sign-in URLs reach the operating system launcher. */
export async function openCodexLogin(url: string) {
  return openLoginUrl(codexLoginUrl(url))
}

export async function openCursorLogin(url: string) {
  return openLoginUrl(cursorLoginUrl(url))
}

async function openLoginUrl(target: string) {
  const command = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -WindowStyle Hidden -FilePath '" + target.replace(/'/g, "''") + "'"]
    : process.platform === "darwin" ? ["open", target] : ["xdg-open", target]
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
  if (await child.exited !== 0) throw new Error("Could not open official sign-in in the browser")
}
import { cursorLoginUrl } from "./cursor-policy"
