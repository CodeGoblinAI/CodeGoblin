import { describe, expect, test } from "bun:test"
import { runCommand } from "../src/core/commands"
import { isReadOnlyCommand } from "../src/core/permission"

describe("/plan and /approvals", () => {
  test("/plan with a request plans that request", () => {
    expect(runCommand("/plan add dark mode")).toEqual({ kind: "plan", text: "add dark mode" })
  })

  test("bare /plan switches planning", () => {
    expect(runCommand("/plan")).toEqual({ kind: "plan", text: undefined })
  })

  test("/approvals opens the picker, and /mode is the same thing", () => {
    expect(runCommand("/approvals")).toEqual({ kind: "approvals" })
    expect(runCommand("/mode")).toEqual({ kind: "approvals" })
  })
})

/**
 * What Approve for me runs without asking, and planning allows.
 *
 * Wrongly calling a command read-only runs it unasked, which is the expensive
 * mistake; wrongly calling it risky only costs a prompt. So the list is short
 * and the checks are strict.
 */
describe("what counts as only looking", () => {
  test("commands that cannot change anything", () => {
    for (const command of ["git status", "git diff HEAD~1", "git log --oneline -5", "ls -la", "dir", "rg TODO src", "cat a.txt | wc -l", "echo hello", "pwd && git show HEAD", "git log --oneline -10 2>&1 | head -20", "git status 2>nul", "ls 2>/dev/null"]) {
      expect([command, isReadOnlyCommand(command)]).toEqual([command, true])
    }
  })

  test("anything that can - including a read-only command made to write", () => {
    const risky = [
      "git status > status.txt",
      "git commit -m wip",
      "git branch -D old",
      "git log --output=log.txt",
      "git -c core.pager=evil log",
      "find . -delete",
      "npm test",
      "echo $(whoami)",
      "echo `whoami`",
      "bash -c ls",
      "rg --pre=cat pattern",
      "ls && rm notes.txt",
      "git log > out.txt 2>&1",
      "echo x >nul.txt",
      "",
    ]
    for (const command of risky) {
      expect([command, isReadOnlyCommand(command)]).toEqual([command, false])
    }
  })
})
