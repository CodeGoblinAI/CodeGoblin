import type { Hooks, PluginInput } from "@codegoblin/plugin"
import { cliAgentExecutable, type CliAgentProviderID } from "@/provider/cli-agent"

const CONNECTED_KEY = "codegoblin-local-cli"

export async function ClaudeCodeCliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return cliAgentAuth("claude-code")
}

export async function CursorAgentCliAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return cliAgentAuth("cursor-agent")
}

function cliAgentAuth(providerID: CliAgentProviderID): Hooks {
  return {
    auth: {
      provider: providerID,
      methods: [
        {
          type: "oauth",
          label: providerID === "claude-code" ? "Connect installed Claude Code" : "Connect installed Cursor Agent",
          authorize: async () => {
            const executable = cliAgentExecutable(providerID)
            if (!executable) throw new Error(missingExecutableMessage(providerID))

            const login = (await authenticated(providerID, executable))
              ? Promise.resolve({ ok: true as const, detail: "" })
              : run(executable, loginArgs(providerID))

            return {
              url: providerID === "claude-code" ? "https://claude.ai/code" : "https://cursor.com/cli",
              method: "auto" as const,
              instructions:
                providerID === "claude-code"
                  ? "Claude Code will open your browser if sign-in is needed. CodeGoblin never receives or stores your Claude credentials."
                  : "Cursor Agent will open your browser if sign-in is needed. CodeGoblin never receives or stores your Cursor credentials.",
              callback: async () => {
                const result = await login
                if (!result.ok) return { type: "failed" as const, message: result.detail }
                if (!(await authenticated(providerID, executable))) {
                  return {
                    type: "failed" as const,
                    message: `${providerName(providerID)} did not report an authenticated account after login.`,
                  }
                }
                return { type: "success" as const, key: CONNECTED_KEY }
              },
            }
          },
        },
      ],
    },
  }
}

async function authenticated(providerID: CliAgentProviderID, executable: string) {
  const result = await run(executable, providerID === "claude-code" ? ["auth", "status"] : ["status"])
  if (!result.ok) return false
  if (providerID === "cursor-agent") return !/not authenticated|not logged in|logged out/i.test(result.detail)
  try {
    const status = JSON.parse(result.detail) as { loggedIn?: boolean }
    return status.loggedIn === true
  } catch {
    return false
  }
}

async function run(executable: string, args: string[]) {
  const proc = Bun.spawn([executable, ...args], {
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
    detail:
      (exitCode === 0 ? stdout : stderr || stdout).trim() ||
      `${providerNameFromExecutable(executable)} exited with code ${exitCode}`,
  }
}

function loginArgs(providerID: CliAgentProviderID) {
  return providerID === "claude-code" ? ["auth", "login", "--claudeai"] : ["login"]
}

function missingExecutableMessage(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") {
    return "Claude Code is not installed or is not on PATH. Install the official Claude Code CLI, then run /connect again."
  }
  return "Cursor Agent is not installed or is not on PATH. Install the official Cursor CLI (Windows requires WSL), then run /connect again."
}

function providerName(providerID: CliAgentProviderID) {
  return providerID === "claude-code" ? "Claude Code" : "Cursor Agent"
}

function providerNameFromExecutable(executable: string) {
  return executable.toLowerCase().includes("cursor") ? "Cursor Agent" : "Claude Code"
}
