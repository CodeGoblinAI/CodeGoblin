import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { exportSession, toMarkdown } from "../src/core/export"
import { create } from "../src/core/sessions"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"

test("exports use the requested filename and keep the default when it is omitted", async () => {
  const root = path.join(Global.Path.home, "export-workspace")
  requireSandbox(path.join(root, "named.md"), "export tests")
  const session = create("local")
  session.title = "A useful conversation"
  session.messages = [
    { role: "system", content: "private internal prompt" },
    { role: "user", content: "expanded file", display: "@note.txt" },
    { role: "assistant", content: "Hello" },
  ]
  const when = Date.UTC(2026, 9, 4)
  expect(await exportSession(session, root, when, "reports/named.md")).toBe(path.join("reports", "named.md"))
  expect(await Bun.file(path.join(root, "reports/named.md")).text()).toBe(toMarkdown(session, when))
  expect(toMarkdown(session, when)).toContain("@note.txt")
  expect(toMarkdown(session, when)).not.toContain("private internal prompt")
  expect(await exportSession(session, root, when)).toBe("codegoblin-a-useful-conversation.md")
  const outside = path.join(Global.Path.home, "export-explicit-outside.md")
  expect(await exportSession(session, root, when, outside)).toBe(outside)
  expect(await fs.stat(outside).then((stat) => stat.isFile())).toBe(true)
})
