import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { forkTranscript, listFork } from "../src/core/fork-import"
import { rankCommands } from "../src/core/command-rank"
import { COMMANDS } from "../src/core/commands"
import { PROMPT_COMMANDS } from "../src/core/prompt-commands"
import { Permissions } from "../src/core/permission"

/**
 * Differential tests for the 0.3 -> 0.4 migration and TUI/Web parity.
 *
 * Runs randomized inputs through both the reference oracle (0.3 database layout,
 * web app.js copy, and reference deny-first rule semantics) and CG-Next's implementation,
 * asserting identical results across every generated case.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (rng: () => number, min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!

describe("differential migration and surface parity checks", () => {
  test("0.3 SQLite multi-step turns import identically to the 0.3 screen-rendering oracle across 50 random sessions", async () => {
    const rng = mulberry32(0x0304_2026)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-diff-fork-"))
    const dbPath = path.join(dir, "codegoblin.db")
    const projectRoot = path.join(dir, "workspace")
    fs.mkdirSync(projectRoot, { recursive: true })

    const db = new Database(dbPath)
    db.exec(`
      create table session (id text primary key, parent_id text, title text, directory text, time_updated integer, time_archived integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, data text);
    `)

    const insertSession = db.prepare("insert into session values (?, ?, ?, ?, ?, ?)")
    const insertMessage = db.prepare("insert into message values (?, ?, ?, ?)")
    const insertPart = db.prepare("insert into part values (?, ?, ?)")

    const expectedBySession = new Map<string, { role: "user" | "assistant"; content: string }[]>()

    for (let s = 0; s < 50; s++) {
      const sid = `ses_diffcheck${String(s).padStart(4, "0")}abcd`
      const isSubagent = s % 11 === 0
      const isArchived = s % 13 === 0
      const isOtherDir = s % 7 === 0
      const dirSpelling = process.platform === "win32" && s % 2 === 1 ? projectRoot.toUpperCase() : projectRoot
      insertSession.run(
        sid,
        isSubagent ? "ses_parent0000abcd" : null,
        `Session ${s}`,
        isOtherDir ? path.join(dir, "other") : dirSpelling,
        1_700_000_000_000 + s * 1000,
        isArchived ? 1_700_000_500_000 : null,
      )

      // Reference oracle: what a person actually saw in 0.3 (non-synthetic, non-ignored text parts merged across consecutive same-role steps).
      const oracle: { role: "user" | "assistant"; content: string }[] = []
      const stepCount = int(rng, 2, 12)
      for (let m = 0; m < stepCount; m++) {
        const mid = `msg_${s}_${String(m).padStart(3, "0")}`
        const role = pick(rng, ["user", "assistant", "assistant"] as const)
        insertMessage.run(mid, sid, 1_700_000_000_000 + m * 10, JSON.stringify({ role }))

        const partCount = int(rng, 0, 4)
        for (let p = 0; p < partCount; p++) {
          const pid = `prt_${s}_${m}_${p}`
          const kind = pick(rng, ["text", "text", "tool", "reasoning", "synthetic", "ignored", "blank"] as const)
          let partObj: Record<string, unknown>
          if (kind === "text") {
            const words = `turn-${s}-${m}-${p}`
            partObj = { type: "text", text: `  ${words}  ` }
            const prev = oracle.at(-1)
            if (prev && prev.role === role) prev.content += "\n\n" + words
            else oracle.push({ role, content: words })
          } else if (kind === "synthetic") {
            partObj = { type: "text", text: "app reminder", synthetic: true }
          } else if (kind === "ignored") {
            partObj = { type: "text", text: "dropped draft", ignored: true }
          } else if (kind === "blank") {
            partObj = { type: "text", text: "   \n  " }
          } else {
            partObj = { type: kind, text: "internal" }
          }
          insertPart.run(pid, mid, JSON.stringify(partObj))
        }
      }
      if (!isSubagent && !isArchived && !isOtherDir) expectedBySession.set(sid, oracle)
    }

    const prevEnv = process.env.CG_FORK_DB
    process.env.CG_FORK_DB = dbPath
    try {
      const listedIds: string[] = []
      let cursor: string | undefined
      do {
        const page = await listFork(projectRoot, cursor)
        listedIds.push(...page.sessions.map((row) => row.id))
        cursor = page.next
      } while (cursor)

      expect(listedIds.sort()).toEqual([...expectedBySession.keys()].sort())
      for (const [sid, expected] of expectedBySession) {
        const actual = forkTranscript(db, sid).map(({ role, content }) => ({ role, content }))
        expect(actual).toEqual(expected)
      }
    } finally {
      if (prevEnv === undefined) delete process.env.CG_FORK_DB
      else process.env.CG_FORK_DB = prevEnv
      db.close()
    }
  })

  test("TUI and Web slash-command rankers produce identical orderings across 200 random queries and recents", () => {
    const appJs = fs.readFileSync(path.resolve(import.meta.dir, "../src/web/app.js"), "utf8")
    const scoreMatch = /function commandScore\([\s\S]*?\n\}/.exec(appJs)?.[0]
    const rankMatch = /function rankCommands\([\s\S]*?\n\}/.exec(appJs)?.[0]
    expect(scoreMatch).toBeDefined()
    expect(rankMatch).toBeDefined()
    const webRank = new Function(`${scoreMatch}\n${rankMatch}\nreturn rankCommands;`)() as typeof rankCommands

    const items = [
      ...COMMANDS.map((c) => ({ value: c.name, hint: c.description })),
      ...PROMPT_COMMANDS.map((c) => ({ value: "/" + c.name, hint: c.description })),
      { value: "/chrome-browser", hint: "skill - drive Chrome" },
      { value: "/cg-next-project-brain", hint: "skill - project brain" },
    ]

    const rng = mulberry32(0x77eb_7011)
    const alphabet = "abcdefghijklmnopqrstuvwxyz/-_"
    for (let i = 0; i < 200; i++) {
      const qLen = int(rng, 0, 6)
      let query = rng() < 0.5 ? "/" : ""
      for (let k = 0; k < qLen; k++) query += alphabet[int(rng, 0, alphabet.length - 1)]!
      const recentCount = int(rng, 0, 8)
      const recent: string[] = []
      for (let r = 0; r < recentCount; r++) {
        const cand = pick(rng, items).value
        if (!recent.includes(cand)) recent.push(cand)
      }
      expect(webRank(items, query, recent)).toEqual(rankCommands(items, query, recent))
    }
  })

  test("chained bash permission rules obey strictest-wins and literal-specificity oracle across 150 chains", async () => {
    const rng = mulberry32(0x5afe_701e)
    const rules = {
      "*": "allow",
      "git *": "allow",
      "git push*": "ask",
      "git push --force*": "deny",
      "rm -rf *": "deny",
    } as const

    const segments = [
      { text: "git status", expect: "allow" },
      { text: "git diff HEAD", expect: "allow" },
      { text: "git push origin feat", expect: "ask" },
      { text: "git push --force origin main", expect: "deny" },
      { text: "rm -rf build", expect: "deny" },
    ] as const

    for (let i = 0; i < 150; i++) {
      const chosen = [pick(rng, segments), pick(rng, segments)]
      const joiner = pick(rng, [" && ", " ; ", " | "])
      const command = chosen.map((c) => c.text).join(joiner)
      const oracleStrictest = chosen.some((c) => c.expect === "deny") ? "deny" : chosen.some((c) => c.expect === "ask") ? "ask" : "allow"

      let asked = 0
      const perms = new Permissions(async () => {
        asked++
        return "once"
      }, () => rules)
      perms.mode = "full"
      const verdict = await perms.decide("shell", JSON.stringify({ command }))

      if (oracleStrictest === "deny") {
        expect(verdict.allowed).toBe(false)
        expect(asked).toBe(0)
      } else if (oracleStrictest === "ask") {
        expect(verdict.allowed).toBe(true)
        expect(asked).toBe(1)
      } else {
        expect(verdict.allowed).toBe(true)
        expect(asked).toBe(0)
      }
    }
  })
})
