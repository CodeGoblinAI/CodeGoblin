import { expect, test } from "bun:test"
import { isLiveCommand } from "../src/tui/live-commands"
import { Permissions, isReadOnlyCommand } from "../src/core/permission"
import * as sessions from "../src/core/sessions"

test("display and approval commands run live; mutations and prompts queue", () => {
  for (const text of ["/approvals", "/help", "/theme dracula", "/thinking", "/diff"]) expect(isLiveCommand(text)).toBe(true)
  for (const text of ["hello", "/clear", "/resume", "/model local", "/undo", "/compact", "/plan fix this", "/boost", "/custom", "/approvals-extra"]) expect(isLiveCommand(text)).toBe(false)
})

test("mode changes release normal requests but preserve forced ask, deny and plan", () => {
  const permissions = new Permissions(async () => "reject", () => ({ "git push*": "ask", "git reset*": "deny" }))
  const child = permissions.forSubagent("test")
  expect(permissions.automaticVerdict("write_file", "a")).toBeUndefined()
  permissions.mode = "full"
  expect(permissions.automaticVerdict("write_file", "a")).toEqual({ allowed: true })
  expect(child.automaticVerdict("write_file", "a")).toEqual({ allowed: true })
  expect(permissions.automaticVerdict("shell", "git push")).toBeUndefined()
  expect(permissions.automaticVerdict("shell", "git reset --hard")?.allowed).toBe(false)
  permissions.planning = true
  expect(permissions.automaticVerdict("write_file", "a")?.allowed).toBe(false)
})

test("Windows switch values cannot hide outside paths", () => {
  expect(isReadOnlyCommand('findstr /s /n .* /d:C:\\Users\\shawn\\.ssh *')).toBe(false)
  expect(isReadOnlyCommand('findstr /s /n .* /d:.. *')).toBe(false)
})

test("session IDs cannot traverse outside session storage", async () => {
  for (const id of ["../../data/auth", "..\\..\\data\\auth", "C:\\auth", "/auth", ""]) {
    expect(await sessions.load(id)).toBeUndefined()
    expect(await sessions.rename(id, "bad")).toBe(false)
  }
})
