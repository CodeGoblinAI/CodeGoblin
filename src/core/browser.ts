import path from "node:path"
import { Global } from "../platform/paths"
import type { McpServer } from "./config"
import type { McpManager } from "./mcp"

/**
 * /browser: a real Chrome the model can drive.
 *
 * This is Google's Chrome DevTools MCP server, started like any other MCP
 * server - CG-Next already speaks MCP, so there is no extension and no native
 * host to keep connected. The model reads a page as a text snapshot, clicks
 * and types by element, and can read the console and the network log.
 *
 * Two ways in:
 *   - "own": a separate Chrome with a profile of its own, kept between runs,
 *     so signing in to a site there once is enough. Nothing of the person's
 *     everyday browser is exposed.
 *   - "mine": attach to the Chrome the person is already using (Chrome 144+,
 *     with remote debugging turned on at chrome://inspect/#remote-debugging;
 *     Chrome asks each time). Everything open there is within reach, which is
 *     the point and the risk.
 *
 * Off unless asked for, and only for this run: its tools ride along on every
 * request, and tools nobody is using are tokens paid for nothing.
 */
export const BROWSER_SERVER = "browser"

/** Pinned: a moving `@latest` would run whatever was published last, unreviewed. */
export const BROWSER_PACKAGE = "chrome-devtools-mcp@1.13.0"

/**
 * The tools offered, of the server's 27: what it takes to open pages, read
 * them, click and type, and look at the console and the network. Left out are
 * audits, screen recording, logpoints, CSS inspection and dragging - and
 * screenshots, because a tool result reaches the model as text, so a picture
 * would cost a call and show it nothing. take_snapshot is how a page is read.
 */
export const BROWSER_TOOLS = [
  "list_pages", "new_page", "select_page", "close_page", "navigate_page", "wait_for",
  "take_snapshot", "click", "hover", "fill", "fill_form", "type_text", "press_key", "upload_file", "handle_dialog",
  "evaluate_script", "list_console_messages", "get_console_message", "list_network_requests", "get_network_request",
]

export type BrowserMode = "own" | "mine"

export function browserProfileDir(): string {
  return path.join(Global.Path.state, "browser-profile")
}

export function browserServer(mode: BrowserMode, profileDir: string = browserProfileDir()): McpServer {
  return {
    type: "local",
    command: [
      "npx", "-y", BROWSER_PACKAGE,
      // Nothing is reported to Google about what is browsed.
      "--no-usage-statistics", "--no-performance-crux",
      // Tracing, device emulation and heap tools are for tuning a site, not for using one; left out, the tool list is a third shorter.
      "--no-category-performance", "--no-category-emulation", "--no-category-memory",
      // Tools act on the selected page instead of needing a page id on every call - one less thing for a small model to get wrong.
      "--no-page-id-routing",
      ...(mode === "mine" ? ["--autoConnect"] : ["--userDataDir", profileDir]),
    ],
    environment: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
    only: BROWSER_TOOLS,
    enabled: true,
    // The first run downloads the package before it can answer.
    timeout: 120_000,
  }
}

/** Which way the browser is on, from the server the manager holds; undefined when off. */
export function browserMode(manager: McpManager): BrowserMode | undefined {
  // Ours is known by its package; a server of the person's own under the same name is not touched.
  const status = manager.statuses().find((server) => server.name === BROWSER_SERVER && server.target.includes(BROWSER_PACKAGE))
  if (!status) return undefined
  return status.target.includes("--autoConnect") ? "mine" : "own"
}

export const BROWSER_USAGE =
  "/browser on opens a separate Chrome with its own profile. /browser mine attaches to the Chrome you already have open " +
  "(turn on remote debugging at chrome://inspect/#remote-debugging first; Chrome asks before it lets the goblin in). /browser off closes it."

/** One line on where things stand. */
export function browserStatus(manager: McpManager): string {
  const status = browserMode(manager) ? manager.statuses().find((server) => server.name === BROWSER_SERVER) : undefined
  if (!status) return "browser: off. " + BROWSER_USAGE
  const which = browserMode(manager) === "mine" ? "your own Chrome" : "a separate Chrome"
  if (status.status === "connected") return `browser: on, ${which}, ${status.tools.length} tools. /browser off closes it.`
  if (status.status === "connecting") return `browser: starting (${which})...`
  return `browser: not running (${which}) - ${explain(status.error)}`
}

function explain(error: string | undefined): string {
  const text = error ?? "it stopped"
  if (/ENOENT|not found|not recognized/i.test(text)) return "npx was not found. Install Node.js (which includes npx) and try again."
  if (/timed out/i.test(text)) return "it did not start in time. The first run downloads the server; try /browser on again."
  return text.slice(0, 200)
}

/**
 * Turns the browser on (one way or the other) or off, and says what happened.
 * Switching ways closes the first before starting the second.
 */
export async function switchBrowser(manager: McpManager, mode: BrowserMode | "off"): Promise<string> {
  const was = browserMode(manager)
  if (mode === "off") {
    if (!was) return "browser: already off."
    await manager.remove(BROWSER_SERVER)
    return "browser: off."
  }
  if (manager.clients.some((client) => client.name === BROWSER_SERVER) && !was) return "browser: there is already an MCP server called browser in your config; /mcp shows it."
  if (was) await manager.remove(BROWSER_SERVER)
  await manager.add(BROWSER_SERVER, browserServer(mode))
  const line = browserStatus(manager)
  if (!/^browser: on/.test(line)) return line
  return line + (mode === "mine"
    ? " If Chrome showed a prompt, allow it. Everything open in that Chrome is within the goblin's reach."
    : " Sites you sign in to there stay signed in for next time.")
}
