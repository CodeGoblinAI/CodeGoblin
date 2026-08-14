import type { Hooks, PluginInput } from "@codegoblin/plugin"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  cliAgentBaseCommand,
  cliAgentExecutable,
  cliAgentSessionFile,
  type CliAgentProviderID,
} from "@/provider/cli-agent"

const CONNECTED_KEY = "codegoblin-local-cli"
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024

export async function AnthropicCliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      methods: [{ type: "api", label: "API key" }, cliAgentMethod("claude-code")],
    },
  }
}

export async function CursorAgentCliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return cliAgentAuth("cursor-agent")
}

export async function AntigravityCliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return cliAgentAuth("antigravity-cli")
}

function cliAgentAuth(providerID: CliAgentProviderID): Hooks {
  return {
    auth: {
      provider: providerID,
      methods: [cliAgentMethod(providerID)],
    },
  }
}

function cliAgentMethod(providerID: CliAgentProviderID) {
  return {
    type: "oauth" as const,
    label: `${providerName(providerID)} (subscription)`,
    provider: providerID,
    prompts: [
      {
        type: "select" as const,
        key: "setup",
        message: `${providerName(providerID)} setup`,
        options: [
          {
            label: "Use installed CLI",
            value: "installed",
            hint: "Keep the existing installation and open its login flow",
          },
          {
            label: "Install official CLI",
            value: "install",
            hint: "Download the installer for this operating system, then connect",
          },
        ],
      },
    ],
    authorize: async (inputs: Record<string, string> = {}) => {
      const setup = inputs.setup ?? "installed"
      return {
        url: providerURL(providerID),
        method: "auto" as const,
        instructions: `${setup === "install" ? "CodeGoblin will use an existing installation if one is already detected; otherwise the official installer will run for this operating system. " : "Using the installed CLI. "}Complete the ${providerName(providerID)} browser login if prompted. The CLI owns chat history; CodeGoblin stores only the session link in ${cliAgentSessionFile()}. Press Esc to cancel before starting.`,
        callback: async () => {
          const executable =
            cliAgentExecutable(providerID) ?? (setup === "install" ? await install(providerID) : undefined)
          if (!executable) return { type: "failed" as const, message: missingExecutableMessage(providerID) }
          const result = (await authenticated(providerID, executable))
            ? { ok: true as const, detail: "" }
            : await run([...cliAgentBaseCommand(providerID, executable), ...loginArgs(providerID)])
          if (!result.ok) return { type: "failed" as const, message: result.detail }
          if (!(await authenticated(providerID, executable))) {
            return {
              type: "failed" as const,
              message: `${providerName(providerID)} did not report an authenticated account after login.`,
            }
          }
          return { type: "success" as const, key: CONNECTED_KEY, provider: providerID }
        },
      }
    },
  }
}

async function authenticated(providerID: CliAgentProviderID, executable: string) {
  const result = await run([
    ...cliAgentBaseCommand(providerID, executable),
    ...(providerID === "claude-code" ? ["auth", "status"] : providerID === "cursor-agent" ? ["status"] : ["models"]),
  ])
  if (!result.ok) return false
  if (providerID === "cursor-agent") return !/not authenticated|not logged in|logged out/i.test(result.detail)
  if (providerID === "antigravity-cli") {
    return (
      Boolean(result.detail) &&
      !/not authenticated|not logged in|log in|sign in|authentication required/i.test(result.detail)
    )
  }
  try {
    const status = JSON.parse(result.detail) as { loggedIn?: boolean }
    return status.loggedIn === true
  } catch {
    return false
  }
}

async function install(providerID: CliAgentProviderID) {
  const command = installCommand(providerID)
  const installer = verifiedInstaller(providerID)
  if (!command && !installer) {
    throw new Error(`Installing ${providerName(providerID)} is not supported on ${process.platform}.`)
  }
  const result = command ? await run(command) : await runVerifiedInstaller(installer!)
  if (!result.ok) throw new Error(`Could not install ${providerName(providerID)}. ${result.detail}`)
  return cliAgentExecutable(providerID)
}

export function installCommand(providerID: CliAgentProviderID, platform = process.platform) {
  if (providerID !== "claude-code") return
  if (platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", "npm", "install", "-g", "@anthropic-ai/claude-code"]
  }
  if (platform === "linux" || platform === "darwin") return ["npm", "install", "-g", "@anthropic-ai/claude-code"]
}

type VerifiedInstaller = {
  url: string
  sha256: string
  command: (file: string) => string[]
}

/** Mutable vendor bootstrap scripts are pinned before execution. A vendor
 * update therefore fails closed until CodeGoblin reviews and updates the hash. */
export function verifiedInstaller(
  providerID: CliAgentProviderID,
  platform = process.platform,
): VerifiedInstaller | undefined {
  if (providerID === "claude-code") return
  if (platform === "win32") {
    return providerID === "cursor-agent"
      ? {
          url: "https://cursor.com/install?win32=true",
          sha256: "027afaec30c73e8ccde38395aff7471309ca9d881cac514b6b34ba9997f1f1b5",
          command: (file) => ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
        }
      : {
          url: "https://antigravity.google/cli/install.ps1",
          sha256: "51c2cb4fada22ce0228da71b9506370383d6544bfebcec85fe7616a52b805344",
          command: (file) => ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
        }
  }
  if (platform !== "linux" && platform !== "darwin") return
  return providerID === "cursor-agent"
    ? {
        url: "https://cursor.com/install",
        sha256: "a51ebedf2a13bc073d994a6f2defbd1f4d976a6cf116ad678d071c6a363bf3e4",
        command: (file) => ["sh", file],
      }
    : {
        url: "https://antigravity.google/cli/install.sh",
        sha256: "ee1ea43ce4e9e56356c4ab6dad907ef357ae4bdfcaadb682735909fb57c9c640",
        command: (file) => ["sh", file],
      }
}

async function runVerifiedInstaller(installer: VerifiedInstaller) {
  const response = await fetch(installer.url, { redirect: "follow" }).catch(() => undefined)
  if (!response?.ok) return { ok: false, detail: `Installer download failed with HTTP ${response?.status ?? "error"}.` }
  const expected = new URL(installer.url)
  const actual = new URL(response.url)
  if (actual.protocol !== "https:" || actual.host !== expected.host) {
    return { ok: false, detail: "Installer redirected to an untrusted host." }
  }
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_COMMAND_OUTPUT_BYTES) return { ok: false, detail: "Installer exceeded the 1 MB limit." }
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(body)
  if (hasher.digest("hex") !== installer.sha256) {
    return {
      ok: false,
      detail: "The official installer changed and failed CodeGoblin's integrity check. Update CodeGoblin and retry.",
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-cli-install-"))
  const file = path.join(directory, process.platform === "win32" ? "install.ps1" : "install.sh")
  try {
    await Bun.write(file, body)
    if (process.platform !== "win32") await fs.chmod(file, 0o700)
    return await run(installer.command(file))
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function run(command: string[]) {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: process.platform === "win32",
  })
  const timeout = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      readLimitedText(proc.stdout),
      readLimitedText(proc.stderr),
    ])
    return {
      ok: exitCode === 0,
      detail: (exitCode === 0 ? stdout : stderr || stdout).trim() || `Command exited with code ${exitCode}`,
    }
  } catch (error) {
    proc.kill()
    await proc.exited.catch(() => undefined)
    return { ok: false, detail: error instanceof Error ? error.message : "Command failed." }
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimitedText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let value = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    value += decoder.decode(next.value, { stream: true })
    if (value.length > MAX_COMMAND_OUTPUT_BYTES) {
      await reader.cancel()
      throw new Error("Command output exceeded the 1 MB limit.")
    }
  }
  return value + decoder.decode()
}

function loginArgs(providerID: CliAgentProviderID) {
  return providerID === "claude-code" ? ["auth", "login", "--claudeai"] : ["login"]
}

function missingExecutableMessage(providerID: CliAgentProviderID) {
  return `${providerName(providerID)} was not found on PATH after the official installer completed.`
}

function providerName(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") return "Claude Code CLI"
  if (providerID === "cursor-agent") return "Cursor Agent CLI"
  return "Antigravity CLI"
}

function providerURL(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") return "https://claude.ai/code"
  if (providerID === "cursor-agent") return "https://cursor.com/cli"
  return "https://antigravity.google/docs/cli-getting-started"
}
