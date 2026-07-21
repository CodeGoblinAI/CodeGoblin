import { describe, expect, test } from "bun:test"
import { getSlashCommand, SHARED_SLASH_COMMANDS, slashCommandNames } from "@codegoblin/core/command/catalog"

describe("shared slash command catalog", () => {
  test("TUI and web expose the same built-in names and aliases", () => {
    expect(slashCommandNames("tui")).toEqual(slashCommandNames("web"))
  })

  test("aliases resolve to their canonical command", () => {
    expect(getSlashCommand("/reasoning")?.name).toBe("effort")
    expect(getSlashCommand("/market")?.name).toBe("plugins")
    expect(getSlashCommand("/continue")?.name).toBe("resume")
  })

  test("server-defined commands stay outside the built-in catalog", () => {
    const names: string[] = SHARED_SLASH_COMMANDS.map((command) => command.name)
    expect(names.includes("teach")).toBe(false)
    expect(names.includes("goal")).toBe(false)
    expect(names.includes("grill")).toBe(false)
  })
})
