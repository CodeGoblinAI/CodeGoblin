import { describe, expect, test } from "bun:test"
import { McpManager, withoutServers } from "../src/core/mcp"
import { runCommand } from "../src/core/commands"

/** A manager with two connected servers, no processes behind them. */
function manager(): McpManager {
  const made = new McpManager({})
  const fake = (name: string, tools: string[]) => ({
    name, status: "connected", tools: tools.map((tool) => ({ name: tool, description: tool })),
    config: { type: "local", command: ["x"], environment: {}, enabled: true },
    callTool: async (tool: string) => `${name}:${tool} ran`,
  })
  ;(made.clients as unknown[]).push(fake("notion", ["search"]), fake("github", ["issues"]))
  return made
}

describe("switching an MCP server off for one conversation", () => {
  test("its tools disappear from what the model is offered; the others stay", async () => {
    const all = manager()
    const scoped = withoutServers(all, ["notion"])
    expect(scoped.schema().map((tool) => tool.function.name)).toEqual(["mcp__github__issues"])
    expect(scoped.has("mcp__notion__search")).toBe(false)
    expect(await scoped.call("mcp__github__issues", {})).toBe("github:issues ran")
    expect(await scoped.call("mcp__notion__search", {})).toContain("switched off in this conversation")
    // The manager itself, and so every other conversation, is unchanged.
    expect(all.schema().length).toBe(2)
  })

  test("the model is told, so it does not reach for something else instead", () => {
    expect(withoutServers(manager(), ["notion"]).notice()).toContain("switched these MCP servers off for this conversation: notion")
    expect(withoutServers(manager(), []).notice()).toBeUndefined()
  })

  test("/mcp off and on", () => {
    expect(runCommand("/mcp off notion")).toEqual({ kind: "mcp", toggle: { server: "notion", on: false } })
    expect(runCommand("/mcp on notion")).toEqual({ kind: "mcp", toggle: { server: "notion", on: true } })
    expect(runCommand("/mcp")).toEqual({ kind: "mcp" })
    expect(runCommand("/mcp bogus")).toMatchObject({ kind: "message" })
  })
})
