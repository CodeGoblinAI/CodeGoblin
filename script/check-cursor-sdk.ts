import fs from "node:fs/promises"
import path from "node:path"
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk"
import { Global } from "../src/platform/paths"
import { cursorOptions } from "../src/core/cursor-policy"

if (!process.env.CODEGOBLIN_DIR) throw new Error("Set CODEGOBLIN_DIR to an isolated test profile first")
await fs.mkdir(path.join(Global.Path.tmp, "cursor-sdk"), { recursive: true })
const cwd = await fs.mkdtemp(path.join(Global.Path.tmp, "cursor-sdk", "probe-"))
const options = cursorOptions("not-a-real-key-no-inference", "default", cwd)
options.local!.store = new JsonlLocalAgentStore(path.join(Global.Path.cache, "cursor-sdk-probe"))
try {
  const agent = await Agent.create(options)
  await agent[Symbol.asyncDispose]()
  console.log("Cursor SDK local runtime created/disposed with no native tools. No prompt sent.")
} catch {
  console.log("Cursor SDK imported under this runtime. Agent.create requires a valid SDK key; the fake-key/no-inference probe could not create an agent. Use /login cursor or /connect cursor-api for the live check.")
}
