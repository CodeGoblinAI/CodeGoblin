import type { Hooks, PluginInput } from "@codegoblin/plugin"
import {
  cliAgentBaseCommand,
  cliAgentExecutable,
  cliAgentSessionFile,
  type CliAgentProviderID,
} from "@/provider/cli-agent"

const CONNECTED_KEY = "codegoblin-local-cli"

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
        instructions: `${setup === "install" ? "The official installer will run first. " : "Using the installed CLI. "}Complete the ${providerName(providerID)} browser login if prompted. The CLI owns chat history; CodeGoblin stores only the session link in ${cliAgentSessionFile()}. Press Esc to cancel before starting.`,
        callback: async () => {
          const executable = setup === "install" ? await install(providerID) : cliAgentExecutable(providerID)
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
  if (providerID === "antigravity-cli") return true
  const result = await run([
    ...cliAgentBaseCommand(providerID, executable),
    ...(providerID === "claude-code" ? ["auth", "status"] : ["status"]),
  ])
  if (!result.ok) return false
  if (providerID === "cursor-agent") return !/not authenticated|not logged in|logged out/i.test(result.detail)
  try {
    const status = JSON.parse(result.detail) as { loggedIn?: boolean }
    return status.loggedIn === true
  } catch {
    return false
  }
}

async function install(providerID: CliAgentProviderID) {
  const command = installCommand(providerID)
  if (!command) throw new Error(`Installing ${providerName(providerID)} is not supported on ${process.platform}.`)
  const result = await run(command)
  if (!result.ok) throw new Error(`Could not install ${providerName(providerID)}. ${result.detail}`)
  return cliAgentExecutable(providerID)
}

export function installCommand(providerID: CliAgentProviderID, platform = process.platform) {
  if (platform === "win32") {
    if (providerID === "cursor-agent") {
      return [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm 'https://cursor.com/install?win32=true' | iex",
      ]
    }
    const url =
      providerID === "claude-code" ? "https://claude.ai/install.ps1" : "https://antigravity.google/cli/install.ps1"
    return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${url} | iex`]
  }
  if (platform !== "linux" && platform !== "darwin") return
  const url =
    providerID === "claude-code"
      ? "https://claude.ai/install.sh"
      : providerID === "cursor-agent"
        ? "https://cursor.com/install"
        : "https://antigravity.google/cli/install.sh"
  return ["sh", "-lc", `curl -fsSL ${url} | bash`]
}

async function run(command: string[]) {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return {
    ok: exitCode === 0,
    detail: (exitCode === 0 ? stdout : stderr || stdout).trim() || `Command exited with code ${exitCode}`,
  }
}

function loginArgs(providerID: CliAgentProviderID) {
  return providerID === "claude-code" ? ["auth", "login", "--claudeai"] : ["login"]
}

function missingExecutableMessage(providerID: CliAgentProviderID) {
  return `${providerName(providerID)} was not found on PATH after the official installer completed.`
}

function providerName(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") return "Claude Code CLI"
  if (providerID === "cursor-agent") return "Cursor Agent"
  return "Antigravity CLI"
}

function providerURL(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") return "https://claude.ai/code"
  if (providerID === "cursor-agent") return "https://cursor.com/cli"
  return "https://antigravity.google/docs/cli-getting-started"
}
