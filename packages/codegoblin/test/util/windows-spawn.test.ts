import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// A Bun.spawn without `windowsHide` opens a console window on Windows. That is
// invisible on CI and on Unix, so it kept slipping in: background probes such
// as the Claude Code quota refresh ended up flashing a terminal on the user's
// desktop every few minutes with no obvious source.
//
// util/process.ts `Process.spawn` already defaults the flag, so anything routed
// through that helper is fine and is not covered here. This guards the raw
// call sites, which have to opt in themselves.

const SRC = path.resolve(import.meta.dir, "../../src")

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** Slice from `Bun.spawn(` to its matching close paren, ignoring nesting. */
function callSites(text: string): { index: number; body: string }[] {
  const sites: { index: number; body: string }[] = []
  const marker = "Bun.spawn("
  let from = 0
  for (;;) {
    const start = text.indexOf(marker, from)
    if (start === -1) return sites
    let depth = 0
    let end = start + marker.length - 1
    for (let i = end; i < text.length; i++) {
      if (text[i] === "(") depth++
      else if (text[i] === ")") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    sites.push({ index: start, body: text.slice(start, end + 1) })
    from = end + 1
  }
}

describe("Bun.spawn call sites", () => {
  test("every raw spawn sets windowsHide", () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8")
      if (!text.includes("Bun.spawn(")) continue
      for (const site of callSites(text)) {
        if (site.body.includes("windowsHide")) continue
        const line = text.slice(0, site.index).split("\n").length
        offenders.push(`${path.relative(SRC, file).replace(/\\/g, "/")}:${line}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("the scanner actually finds the known spawn sites", () => {
    // Guards against the walker silently matching nothing and passing above.
    const total = sourceFiles(SRC)
      .map((file) => callSites(fs.readFileSync(file, "utf8")).length)
      .reduce((sum, count) => sum + count, 0)

    expect(total).toBeGreaterThanOrEqual(7)
  })
})
