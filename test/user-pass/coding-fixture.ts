// A small real project and the ordinary coding jobs a person asks for in one, for real-everyday-tasks.ts.
// Each job has a check that reads the folder afterwards, so "done" is what is on disk, not what was said.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "walnut shop", version: "1.1.0", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
  "README.md": "# Walnut shop\n\nA tiny cart.\n",
  "src/money.js": "/** Cents to a price like $12.30. */\nexport function formatPrice(cents) {\n  return \"$\" + (cents / 100).toFixed(1)\n}\n",
  "src/cart.js": "import { formatPrice } from \"./money.js\"\n\nexport function total(items) {\n  return items.reduce((sum, item) => sum + item.cents * item.count, 0)\n}\n\nexport function receipt(items) {\n  return items.map((item) => item.name + \" \" + formatPrice(item.cents * item.count)).join(\"\\n\") + \"\\nTotal \" + formatPrice(total(items))\n}\n",
  "src/discount.js": "import { total } from \"./cart.js\"\n\n// Ten percent off orders over fifty dollars.\nexport function discounted(items) {\n  const sum = total(items)\n  return sum > 5000 ? Math.round(sum * 0.9) : sum\n}\n",
  "src/index.js": "import { receipt } from \"./cart.js\"\nimport { discounted } from \"./discount.js\"\n\nconst items = [{ name: \"walnuts\", cents: 1250, count: 2 }, { name: \"honey\", cents: 899, count: 1 }]\nconsole.log(receipt(items))\nconsole.log(\"To pay \" + discounted(items))\n",
  "test/money.test.js": "import { expect, test } from \"bun:test\"\nimport { formatPrice } from \"../src/money.js\"\n\ntest(\"two decimal places\", () => {\n  expect(formatPrice(1230)).toBe(\"$12.30\")\n  expect(formatPrice(5)).toBe(\"$0.05\")\n})\n",
  "test/cart.test.js": "import { expect, test } from \"bun:test\"\nimport { total } from \"../src/cart.js\"\n\ntest(\"total\", () => {\n  expect(total([{ cents: 100, count: 3 }])).toBe(300)\n})\n",
  "docs/release notes.md": "## 1.1.0\n\n- carts\n",
}

/** The project, in a folder whose name has a space in it, as a git repository with one commit. */
export function codeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg code "))
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false")
    git("add", "-A"); git("commit", "-q", "-m", "first version")
  } catch {}
  return root
}

const read = (root: string, file: string) => { try { return fs.readFileSync(path.join(root, file), "utf8") } catch { return "" } }
const run = (root: string, command: string, args: string[]) => { try { return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) } catch (error) { return "FAILED " + String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "") } }
const testsPass = (root: string) => { const out = run(root, process.execPath, ["test"]); return !out.startsWith("FAILED") }
const dirty = (root: string) => run(root, "git", ["status", "--porcelain"]).trim()

export const CODE_TASKS: Record<string, { ask: string; done: (root: string) => boolean; setup?: (root: string) => void }> = {
  // A failing test, with the bug one character wide in another file.
  fix: { ask: "The tests are failing. Find out why and fix it.", done: (root) => testsPass(root) && /toFixed\(2\)/.test(read(root, "src/money.js")) && read(root, "test/money.test.js").includes('toBe("$12.30")') },
  // A change that has to be made in four files to be right.
  across: { ask: "Rename the function total to cartTotal everywhere it is used.", done: (root) => !run(root, process.execPath, ["test", "test/cart.test.js"]).startsWith("FAILED") && !/\btotal\(/.test(read(root, "src/cart.js") + read(root, "src/discount.js") + read(root, "test/cart.test.js")) && /cartTotal/.test(read(root, "src/discount.js")) && /cartTotal/.test(read(root, "test/cart.test.js")) },
  // A commit, whose message has to survive the shell.
  commit: {
    ask: "Commit my changes with a sensible message.",
    setup: (root) => { fs.appendFileSync(path.join(root, "README.md"), "\nRun `bun test` to check it.\n"); fs.writeFileSync(path.join(root, "src/tax.js"), "export const withTax = (cents) => Math.round(cents * 1.08)\n") },
    done: (root) => dirty(root) === "" && Number(run(root, "git", ["rev-list", "--count", "HEAD"]).trim()) === 2 && run(root, "git", ["log", "-1", "--format=%s"]).trim().length > 8 && !/^"|\\"/.test(run(root, "git", ["log", "-1", "--format=%s"])),
  },
  // A question. The right answer changes nothing.
  ask: { ask: "How is the discount worked out, and where?", done: (root) => dirty(root) === "" },
  // A small edit to a JSON file and a new file beside it.
  version: { ask: "Bump the version to 1.2.0, and add a line for it to the release notes saying it adds tax.", done: (root) => /"version": "1\.2\.0"/.test(read(root, "package.json")) && /1\.2\.0[\s\S]*tax/i.test(read(root, "docs/release notes.md")) && /1\.1\.0/.test(read(root, "docs/release notes.md")) && (() => { try { JSON.parse(read(root, "package.json")); return true } catch { return false } })() },
  // Running the program and reporting what it prints.
  run: { ask: "Run the program and tell me what it prints.", done: (root) => dirty(root) === "" },
}
