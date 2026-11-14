import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { COMMANDS } from "../src/core/commands"

// The preload puts the app's state in a sandbox, so the recents file here is a throwaway one.
const { commandScore, rankCommands, loadRecentCommands, noteCommandUse } = await import("../src/core/command-rank")
const { Global } = await import("../src/platform/paths")
fs.mkdirSync(Global.Path.state, { recursive: true })
fs.writeFileSync(path.join(Global.Path.state, "recent-commands.json"), "[]")

const skills = [
  { value: "/built-in-browser", hint: "skill - Read this skill before the first step that uses the built-in browser" },
  { value: "/chrome-browser", hint: "skill - Read this skill before the first step that uses Claude in Chrome" },
  { value: "/cad-design", hint: "skill - Shawn's working notes on CAD with Claude" },
  { value: "/cg-next-project-brain", hint: "skill - Project brain for CG-Next" },
  { value: "/animating-1930s-cartoons", hint: "skill - Make 1930s rubber-hose cartoon animation" },
]
const items = [...COMMANDS.map((command) => ({ value: command.name, hint: command.description })), ...skills]
const values = (query: string, recent: string[] = []) => rankCommands(items, query, recent).map((item) => item.value)

describe("ranking the / list", () => {
  test("the command whose name you typed comes first, then words inside names", () => {
    const browser = values("/browser")
    expect(browser[0]).toBe("/browser")
    expect(browser.slice(1, 3).sort()).toEqual(["/built-in-browser", "/chrome-browser"])
    expect(values("/mod").slice(0, 2).sort()).toEqual(["/mode", "/model"])
  })

  test("a word inside a name finds it, which a prefix never did", () => {
    expect(values("/brain")).toContain("/cg-next-project-brain")
    expect(values("/cartoon")[0]).toBe("/animating-1930s-cartoons")
  })

  test("letters in order find a name; a description word finds a skill", () => {
    expect(values("/cbr")).toContain("/chrome-browser")
    expect(values("/rubber")).toContain("/animating-1930s-cartoons")
    expect(values("/zzzzqq")).toEqual([])
  })

  test("recently used come first when nothing is typed, and rise among equals - never above a closer match", () => {
    expect(values("/", ["/chrome-browser", "/built-in-browser"]).slice(0, 2)).toEqual(["/chrome-browser", "/built-in-browser"])
    const browser = values("/browser", ["/chrome-browser"])
    expect(browser[0]).toBe("/browser")
    expect(browser[1]).toBe("/chrome-browser")
  })

  test("scores, in order of closeness", () => {
    const score = (value: string, query: string, hint = "") => commandScore(value, hint, query)
    expect(score("/model", "/model")).toBeGreaterThan(score("/model", "/mod"))
    expect(score("/model", "/mod")).toBeGreaterThan(score("/built-in-browser", "/browser"))
    expect(score("/built-in-browser", "/browser")).toBeGreaterThan(score("/abrowserz", "/browser"))
    expect(score("/abrowserz", "/browser")).toBeGreaterThan(score("/x", "/browser", "opens the browser"))
    expect(score("/x", "/browser", "opens the browser")).toBeGreaterThan(score("/brxowxser", "/browser"))
    expect(score("/x", "/q")).toBe(-1)
  })
})

describe("the web page ranks the same way", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
  const start = source.indexOf("function commandScore(")
  const end = source.indexOf("/** Remembers the commands and skills in a sent message")
  const webRank = new Function(source.slice(start, end) + "; return rankCommands")() as typeof rankCommands

  test("for a spread of queries, with and without recents", () => {
    for (const query of ["/", "/b", "/browser", "/mod", "/brain", "/cbr", "/rubber", "/c", "/zz", "/co"]) {
      for (const recent of [[], ["/chrome-browser", "/compact"]]) {
        expect([query, webRank(items, query, recent).map((item) => item.value)]).toEqual([query, values(query, recent)])
      }
    }
  })
})

describe("recently used commands", () => {
  test("newest first, no repeats, only /words, kept between runs", () => {
    expect(loadRecentCommands()).toEqual([])
    noteCommandUse("/compact")
    noteCommandUse("/browser")
    noteCommandUse("/compact")
    expect(noteCommandUse("not a command")).toEqual(["/compact", "/browser"])
    expect(noteCommandUse("/two words")).toEqual(["/compact", "/browser"])
    expect(loadRecentCommands()).toEqual(["/compact", "/browser"])
  })
})
