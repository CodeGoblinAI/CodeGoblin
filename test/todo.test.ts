import { describe, expect, test } from "bun:test"
import { parseTodos, summarise, counts, marker } from "../src/core/todo"

describe("todo parsing", () => {
  // Models send imperfect JSON; a malformed plan should degrade, not throw.
  test("keeps well-formed items", () => {
    const todos = parseTodos([{ content: "read the file", status: "completed" }])
    expect(todos).toEqual([{ content: "read the file", status: "completed" }])
  })

  test("defaults an unknown status to pending", () => {
    expect(parseTodos([{ content: "x", status: "banana" }])[0]!.status).toBe("pending")
  })

  test("drops empty entries rather than rendering blanks", () => {
    expect(parseTodos([{ content: "  " }, { content: "real" }])).toHaveLength(1)
  })

  test("survives being handed something that is not a list", () => {
    expect(parseTodos("nope")).toEqual([])
    expect(parseTodos(undefined)).toEqual([])
  })

  test("caps a runaway plan", () => {
    expect(parseTodos(Array.from({ length: 80 }, () => ({ content: "x" })))).toHaveLength(30)
  })
})

describe("todo display", () => {
  test("summary shows progress and the active item", () => {
    const todos = parseTodos([
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
      { content: "three", status: "pending" },
    ])
    expect(summarise(todos)).toContain("1/3")
    expect(summarise(todos)).toContain("two")
  })

  test("counts each state", () => {
    const todos = parseTodos([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ])
    expect(counts(todos)).toEqual({ total: 2, done: 1, active: 1 })
  })

  test("markers differ per state", () => {
    expect(new Set([marker("pending"), marker("in_progress"), marker("completed")]).size).toBe(3)
  })
})
