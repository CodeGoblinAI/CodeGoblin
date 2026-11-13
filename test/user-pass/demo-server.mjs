// A CG-Next web server to look at by hand or in a real browser: fake model, throwaway profile and project.
// Prints the URL and stays up until killed. Run: node test/user-pass/demo-server.mjs
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { env, fakeModel, tempDir } from "./harness.mjs"
const reply = "Here is what I found.\n\n## Plan\n\n1. Read `src/core/agent.ts`\n2. Add the guard\n\n```ts\nexport function guard(n: number) {\n  return n > 0\n}\n```\n\n| File | Change |\n| --- | --- |\n| agent.ts | guard added |\n\nDone: **1 file** changed."
let n = 0
const model = await fakeModel(() => (++n % 2 === 1
  ? { tool: "glob", args: { pattern: "*.md" }, usage: { prompt_tokens: 4200, completion_tokens: 30 } }
  : { text: reply, usage: { prompt_tokens: 4300, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 4096 } } }))
const project = tempDir("cg-demo-project-")
fs.writeFileSync(path.join(project, "README.md"), "# demo\n")
const server = spawn("bun", ["C:/Users/shawn/code/CG-Next/src/web/serve.ts"], { cwd: project, env: env(model, tempDir("cg-demo-profile-")), stdio: ["ignore", "inherit", "inherit"], windowsHide: true })
process.on("SIGINT", () => { server.kill(); process.exit(0) })
