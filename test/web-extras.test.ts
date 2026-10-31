import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentMention } from "../src/core/subagents"
import { paletteFor, setAgents } from "../src/tui/palette"
import { runCommand } from "../src/core/commands"

describe("@-mentioning an agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-agents-"))

  test("a message that starts with an agent's name hands the task to it", () => {
    const found = agentMention("@explore  where is the theme set?", root)
    expect(found?.agent.name).toBe("explore")
    expect(found?.task).toBe("where is the theme set?")
    expect(found?.content).toContain("Start the explore subagent with the task tool")
  })

  test("an @file, an @name that is no agent, or an agent with nothing to do, is not a hand-off", () => {
    expect(agentMention("@src/app.ts what does this do?", root)).toBeUndefined()
    expect(agentMention("@nobody do it", root)).toBeUndefined()
    expect(agentMention("@explore", root)).toBeUndefined()
    expect(agentMention("look at @explore later", root)).toBeUndefined()
  })

  test("project agent files count too", () => {
    fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true })
    fs.writeFileSync(path.join(root, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews diffs\n---\nReview carefully.")
    expect(agentMention("@reviewer check my last change", root)?.agent.name).toBe("reviewer")
  })

  test("the terminal's @ list offers agents first at the start of a message, and only files after that", () => {
    setAgents([{ name: "explore", description: "Reads and searches" }])
    const start = paletteFor("@ex") ?? []
    expect(start[0]).toEqual({ value: "@explore", hint: "agent - Reads and searches" })
    const later = paletteFor("look at @ex") ?? []
    expect(later.some((item) => item.value === "@explore")).toBe(false)
    setAgents([])
  })
})

describe("/open", () => {
  test("points the terminal at @mentions instead", () => {
    expect(runCommand("/open")).toMatchObject({ kind: "message" })
  })
})
