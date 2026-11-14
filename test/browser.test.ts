import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { McpServer } from "../src/core/config"
import { McpManager, StdioTransport } from "../src/core/mcp"
import { BROWSER_PACKAGE, BROWSER_SERVER, BROWSER_TOOLS, browserMode, browserServer, browserStatus, switchBrowser } from "../src/core/browser"
import { COMMANDS, runCommand } from "../src/core/commands"

const fixture = path.join(import.meta.dir, "fixtures", "mcp-fixture-server.ts")
const open: McpManager[] = []
afterEach(async () => { await Promise.all(open.splice(0).map((each) => each.close())) })

/** A manager whose servers are all the fixture, whatever command they name - so nothing is downloaded or launched. */
function manager(seen: McpServer[] = [], servers: Record<string, McpServer> = {}) {
  const made = new McpManager(servers, (config) => {
    seen.push(config)
    return new StdioTransport([process.execPath, fixture], {})
  })
  open.push(made)
  return made
}

describe("the browser server's command", () => {
  test("a pinned package, nothing reported to Google, and the heavy tool groups left out", () => {
    const own = browserServer("own", "C:/state/browser-profile")
    if (own.type !== "local") throw new Error("local expected")
    expect(BROWSER_PACKAGE).toMatch(/^chrome-devtools-mcp@\d+\.\d+\.\d+$/)
    expect(own.command.slice(0, 3)).toEqual(["npx", "-y", BROWSER_PACKAGE])
    for (const flag of ["--no-usage-statistics", "--no-performance-crux", "--no-category-performance", "--no-category-emulation", "--no-category-memory"]) expect(own.command).toContain(flag)
    expect(own.environment.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe("1")
    expect(own.timeout).toBeGreaterThanOrEqual(60_000)
    // A short list: reading, acting, console and network - no screenshots, which the model could not see.
    expect(own.only).toEqual(BROWSER_TOOLS)
    expect(BROWSER_TOOLS).toContain("take_snapshot")
    expect(BROWSER_TOOLS).not.toContain("take_screenshot")
    expect(BROWSER_TOOLS.length).toBeLessThanOrEqual(20)
  })

  test("its own profile by default; the person's Chrome only when asked", () => {
    const own = browserServer("own", "C:/state/browser-profile")
    const mine = browserServer("mine", "C:/state/browser-profile")
    if (own.type !== "local" || mine.type !== "local") throw new Error("local expected")
    expect(own.command.slice(-2)).toEqual(["--userDataDir", "C:/state/browser-profile"])
    expect(own.command).not.toContain("--autoConnect")
    expect(mine.command).toContain("--autoConnect")
    expect(mine.command).not.toContain("--userDataDir")
  })
})

describe("/browser", () => {
  test("the command parses to on, mine, off or status", () => {
    expect(COMMANDS.some((command) => command.name === "/browser")).toBe(true)
    expect(runCommand("/browser")).toEqual({ kind: "browser" })
    expect(runCommand("/browser on")).toEqual({ kind: "browser", mode: "own" })
    expect(runCommand("/browser mine")).toEqual({ kind: "browser", mode: "mine" })
    expect(runCommand("/browser off")).toEqual({ kind: "browser", mode: "off" })
    expect(runCommand("/browser sideways")).toMatchObject({ kind: "message" })
  })

  test("off until asked; on adds its tools; off takes them away", async () => {
    const seen: McpServer[] = []
    const mcp = manager(seen)
    let changes = 0
    mcp.onChange = () => { changes++ }
    expect(browserStatus(mcp)).toContain("browser: off")
    expect(await switchBrowser(mcp, "off")).toBe("browser: already off.")

    const on = await switchBrowser(mcp, "own")
    expect(on).toMatch(/^browser: on, a separate Chrome, \d+ tools\./)
    expect(browserMode(mcp)).toBe("own")
    // The fixture's tools are not on the browser's list, so none is offered: the list is enforced.
    expect(mcp.schema()).toEqual([])
    expect(on).toContain(" 0 tools")
    expect(changes).toBeGreaterThan(0)

    expect(await switchBrowser(mcp, "off")).toBe("browser: off.")
    expect(browserMode(mcp)).toBeUndefined()
    expect(mcp.schema()).toEqual([])
    expect(mcp.statuses()).toEqual([])
  })

  test("switching to the person's Chrome closes the first and starts the second, with the warning", async () => {
    const seen: McpServer[] = []
    const mcp = manager(seen)
    await switchBrowser(mcp, "own")
    const mine = await switchBrowser(mcp, "mine")
    expect(mine).toContain("your own Chrome")
    expect(mine).toContain("within the goblin's reach")
    expect(browserMode(mcp)).toBe("mine")
    expect(mcp.statuses().filter((server) => server.name === BROWSER_SERVER)).toHaveLength(1)
    expect(seen).toHaveLength(2)
  })

  test("a server of the person's own called browser is left alone", async () => {
    const mcp = manager([], { browser: { type: "local", command: ["their-own-browser-server"], environment: {}, enabled: true } })
    await mcp.start()
    expect(await switchBrowser(mcp, "off")).toBe("browser: already off.")
    expect(await switchBrowser(mcp, "own")).toContain("already an MCP server called browser")
    expect(mcp.statuses().map((server) => server.target)).toEqual(["their-own-browser-server"])
  })

  test("a server that cannot start says why, in words", async () => {
    const mcp = new McpManager({}, () => new StdioTransport(["cg-next-no-such-program-" + "xyz"], {}))
    open.push(mcp)
    const line = await switchBrowser(mcp, "own")
    expect(line).toMatch(/^browser: not running \(a separate Chrome\) - /)
    expect(line.length).toBeLessThan(320)
  })
})
