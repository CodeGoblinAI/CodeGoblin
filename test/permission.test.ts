import { describe, expect, test } from "bun:test"
import { Permissions } from "../src/core/permission"

describe("permissions", () => {
  test("read-only tools never prompt", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "allow" })
    for (const tool of ["read_file", "list_files", "grep", "glob"]) {
      expect(await permissions.check(tool, "")).toBe(true)
    }
    expect(asked).toBe(0)
  })

  // The whole point of per-session granularity: asking every time trains
  // people to approve without reading.
  test("asks once per tool, then remembers", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "allow" })
    await permissions.check("write_file", "a")
    await permissions.check("write_file", "b")
    await permissions.check("write_file", "c")
    expect(asked).toBe(1)
  })

  test("a refusal is remembered too, and blocks", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "deny" })
    expect(await permissions.check("shell", "rm -rf /")).toBe(false)
    expect(await permissions.check("shell", "anything")).toBe(false)
    expect(asked).toBe(1)
  })

  test("different tools are approved separately", async () => {
    const seen: string[] = []
    const permissions = new Permissions(async (tool) => { seen.push(tool); return "allow" })
    await permissions.check("write_file", "")
    await permissions.check("shell", "")
    expect(seen).toEqual(["write_file", "shell"])
  })

  test("a new conversation clears standing approvals", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "allow" })
    await permissions.check("shell", "")
    permissions.reset()
    await permissions.check("shell", "")
    expect(asked).toBe(2)
  })
})
