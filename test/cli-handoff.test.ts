import { expect, test } from "bun:test"
import { cliHandoff } from "../src/core/cli-handoff"
import { runCommand } from "../src/core/commands"
import { formatContext } from "../src/core/context"

test("guided Claude/Cursor sign-in stays external and warns about shared authentication", () => {
  expect(runCommand("/login claude")).toEqual({ kind: "cli-login", source: "claude" })
  expect(runCommand("/login claude-code")).toEqual({ kind: "cli-login", source: "claude" })
  expect(runCommand("/login cursor-cli")).toEqual({ kind: "cli-login", source: "cursor" })
  expect(runCommand("/login cursor anything").kind).toBe("message")
  expect(cliHandoff("claude").command).toBe("claude auth login --claudeai")
  expect(cliHandoff("cursor").command).toBe("agent login")
  expect(cliHandoff("claude").warning).toContain("does not cancel")
})

test("unknown CLI context window is unavailable, never zero-percent certainty", () => {
  expect(formatContext({ used: 400, limit: 0, percent: 0 })).toBe("~400 tokens; window unavailable")
  expect(formatContext({ used: 400, limit: 1000, percent: 40 })).toBe("~400 / 1,000 (40%)")
})
