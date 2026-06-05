import path from "path"
import { InstallationVersion } from "@codegoblin/core/installation/version"
import { isNativeAvailable, nativeBinPath, resolveNativeBinPath } from "./memory-native"
import { embeddedUI, resolveLocalWebUIDist, webUIDevURL, webUIUpstream } from "@/server/shared/ui"

export type WebUISource = "embedded" | "local-dist" | "dev-proxy" | "upstream-proxy" | "unavailable"

export type RuntimeStatus = {
  version: string
  memoryNative: boolean
  memoryNativePath?: string
  webUI: WebUISource
  execPath?: string
}

export async function resolveWebUISource(disableEmbedded = false): Promise<WebUISource> {
  const embedded = await embeddedUI(disableEmbedded)
  if (embedded && Object.keys(embedded).length > 0) return "embedded"
  if (resolveLocalWebUIDist()) return "local-dist"
  if (webUIDevURL()) return "dev-proxy"
  if (webUIUpstream()) return "upstream-proxy"
  return "unavailable"
}

export async function collectRuntimeStatus(): Promise<RuntimeStatus> {
  const nativePath = (await resolveNativeBinPath()) ?? nativeBinPath()
  return {
    version: InstallationVersion,
    memoryNative: isNativeAvailable(),
    memoryNativePath: nativePath,
    webUI: await resolveWebUISource(false),
    execPath: process.execPath,
  }
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  const lines = [
    `CodeGoblin ${status.version}`,
    `Memory native: ${status.memoryNative ? "active" : "fallback (TS)"}${status.memoryNativePath ? ` · ${status.memoryNativePath}` : ""}`,
    `Web UI: ${status.webUI}`,
  ]
  if (status.execPath) lines.push(`Binary: ${path.basename(status.execPath)}`)
  return lines.join("\n")
}
