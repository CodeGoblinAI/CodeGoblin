import { describe, expect, test } from "bun:test"
import { runCommand, COMMANDS } from "../src/core/commands"
import { THEMES, themeNames, paletteOf, isTheme, DEFAULT_THEME } from "../src/core/theme"
import { normalise, defaults } from "../src/core/settings"
import { effortFor, takesEffort } from "../src/core/providers"
import { toMarkdown, slug } from "../src/core/export"
import type { Session } from "../src/core/sessions"

const NEWLINE = String.fromCharCode(10)

describe("the new commands", () => {
  test("every command in the list actually does something", () => {
    for (const command of COMMANDS) {
      const result = runCommand(command.name)
      // An unknown command falls through to a message saying so; nothing in
      // the advertised list should reach that.
      expect([command.name, result.kind === "message" && result.text.startsWith("unknown")]).toEqual([
        command.name,
        false,
      ])
    }
  })

  test("/rename carries the title, and asks for one when missing", () => {
    expect(runCommand("/rename plan review")).toEqual({ kind: "rename", title: "plan review" })
    expect(runCommand("/rename")).toEqual({ kind: "message", text: "usage: /rename a shorter title" })
  })

  test("/theme takes a known name and refuses anything else", () => {
    expect(runCommand("/theme midnight")).toEqual({ kind: "theme", name: "midnight" })
    const unknown = runCommand("/theme neon")
    expect(unknown.kind).toBe("message")
    expect(unknown.kind === "message" && unknown.text).toContain("unknown theme: neon")
  })

  test("/theme on its own asks for the picker, rather than printing names to retype", () => {
    expect(runCommand("/theme")).toEqual({ kind: "theme", name: undefined })
  })

  test("every theme is still reachable by name, for anyone who knows it", () => {
    for (const name of themeNames()) {
      expect(runCommand("/theme " + name)).toEqual({ kind: "theme", name })
    }
  })

  test("/status, /export and /thinking need no argument", () => {
    expect(runCommand("/status")).toEqual({ kind: "status" })
    expect(runCommand("/export")).toEqual({ kind: "export" })
    expect(runCommand("/thinking")).toEqual({ kind: "thinking" })
  })
})

describe("themes", () => {
  test("every theme defines the whole palette, so none renders half-styled", () => {
    const keys = Object.keys(THEMES[DEFAULT_THEME]!.palette).sort()
    for (const name of themeNames()) {
      expect([name, Object.keys(THEMES[name]!.palette).sort()]).toEqual([name, keys])
    }
  })

  test("every colour is a full hex triplet", () => {
    for (const name of themeNames()) {
      for (const [token, value] of Object.entries(THEMES[name]!.palette)) {
        expect([name, token, /^#[0-9a-f]{6}$/.test(value)]).toEqual([name, token, true])
      }
    }
  })

  test("an unknown name falls back rather than returning nothing", () => {
    expect(paletteOf("nonsense")).toEqual(THEMES[DEFAULT_THEME]!.palette)
    expect(isTheme("nonsense")).toBe(false)
    expect(isTheme(DEFAULT_THEME)).toBe(true)
  })

  test("the light theme is actually light, and the dark ones dark", () => {
    const brightness = (hex: string) => parseInt(hex.slice(1, 3), 16)
    expect(brightness(THEMES.paper!.palette.step1)).toBeGreaterThan(200)
    for (const name of ["goblin", "midnight", "ember"]) {
      expect([name, brightness(THEMES[name]!.palette.step1) < 60]).toEqual([name, true])
    }
  })
})

describe("settings", () => {
  test("keeps what is valid and replaces what is not", () => {
    expect(normalise({ theme: "midnight", thinking: false })).toEqual({
      theme: "midnight",
      thinking: false,
      mouse: true,
      effort: "auto",
      effortByModel: {},
      appearance: "dark",
      pasteSummary: true,
      animations: true,
      diffWrap: false,
      favourites: [],
      recents: [],
    })
    expect(normalise({ theme: "not-a-theme", thinking: "yes" })).toEqual(defaults())
    expect(normalise(null)).toEqual(defaults())
    expect(normalise("garbage")).toEqual(defaults())
    expect(normalise({})).toEqual(defaults())
  })

  test("an effort it does not recognise falls back rather than reaching the wire", () => {
    expect(normalise({ effort: "maximum" }).effort).toBe("auto")
    expect(normalise({ effort: 3 }).effort).toBe("auto")
    expect(normalise({ effort: "high" }).effort).toBe("high")
  })

  test("settings written before effort existed still load", () => {
    // A file from an older build has no effort key at all.
    expect(normalise({ theme: "ember", thinking: true, mouse: true }).effort).toBe("auto")
  })
})

describe("exporting a conversation", () => {
  const session: Session = {
    id: "abc123",
    title: "Looking at mentions",
    created: 0,
    updated: 0,
    provider: "deepseek",
    messages: [
      { role: "system", content: "you are a goblin" },
      { role: "user", content: "explain this\n\nAttached files:\n\n--- a.ts ---\nsecret", display: "explain @a.ts" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "1", content: "the file" },
      { role: "assistant", content: "It reads a file." },
    ],
  }

  test("shows what was typed, not the files it pulled in", () => {
    const markdown = toMarkdown(session, Date.UTC(2026, 0, 2, 3, 4))
    expect(markdown).toContain("explain @a.ts")
    expect(markdown).not.toContain("secret")
  })

  test("leaves the system prompt out of the record", () => {
    expect(toMarkdown(session, 0)).not.toContain("you are a goblin")
  })

  test("keeps the tools and their results", () => {
    const markdown = toMarkdown(session, 0)
    expect(markdown).toContain("**read_file**")
    expect(markdown).toContain("the file")
    expect(markdown).toContain("It reads a file.")
  })

  test("opens with the title and stamps the details", () => {
    const markdown = toMarkdown(session, Date.UTC(2026, 0, 2, 3, 4))
    expect(markdown.split(NEWLINE)[0]).toBe("# Looking at mentions")
    expect(markdown).toContain("2026-01-02 03:04")
    expect(markdown).toContain("deepseek")
  })

  test("turns any title into a usable filename", () => {
    expect(slug("Looking at mentions")).toBe("looking-at-mentions")
    expect(slug("  ///  ")).toBe("conversation")
    expect(slug("")).toBe("conversation")
    expect(slug("你好 world")).toBe("world")
    expect(slug("x".repeat(80)).length).toBeLessThanOrEqual(40)
  })
})

describe("every theme is actually readable", () => {
  // A palette is easy to add and easy to get wrong, and "looks a bit washed
  // out" is not something a test suite notices unless it is asked to.
  // Thresholds are WCAG: 4.5 for body text, 3 for accents on large or bold
  // glyphs. Contrast is computed from the palette, so this holds for both
  // surfaces without either having to render anything.
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16) / 255))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high! + 0.05) / (low! + 0.05)
  }

  test("body text clears 4.5 against every surface it sits on", () => {
    for (const name of themeNames()) {
      const p = THEMES[name]!.palette
      for (const surface of [p.step1, p.step2, p.step3]) {
        expect([name, Number(contrast(p.step12, surface).toFixed(2)) >= 4.5]).toEqual([name, true])
      }
    }
  })

  test("muted text clears 4.5 on the main background", () => {
    for (const name of themeNames()) {
      const p = THEMES[name]!.palette
      expect([name, Number(contrast(p.step11, p.step1).toFixed(2)) >= 4.5]).toEqual([name, true])
    }
  })

  test("accents clear 3 on the main background", () => {
    for (const name of themeNames()) {
      const p = THEMES[name]!.palette
      for (const [token, colour] of [["green", p.green], ["gold", p.gold], ["red", p.red]] as const) {
        expect([name, token, Number(contrast(colour, p.step1).toFixed(2)) >= 3]).toEqual([name, token, true])
      }
    }
  })

  test("the greys step in one direction, so borders never outshine text", () => {
    for (const name of themeNames()) {
      const p = THEMES[name]!.palette
      const steps = [p.step1, p.step2, p.step3, p.step5, p.step7, p.step11, p.step12].map(luminance)
      const rising = steps.every((value, index) => index === 0 || value! > steps[index - 1]!)
      const falling = steps.every((value, index) => index === 0 || value! < steps[index - 1]!)
      expect([name, rising || falling]).toEqual([name, true])
    }
  })
})

describe("a command that takes free text", () => {
  test("the palette gets out of the way once an argument is being typed", async () => {
    // The browser had this wrong: it matched on the first word only, so the
    // palette stayed open on "/rename a new title" and enter picked the bare
    // "/rename", throwing the title away. Both surfaces must close the list
    // once there is nothing left to complete.
    const { paletteFor } = await import("../src/tui/palette")
    expect(paletteFor("/rename")).toBeDefined()
    expect(paletteFor("/rename a new title")).toBeUndefined()
    expect(paletteFor("/rename ")).toBeUndefined()
  })
})

describe("who gets the mouse", () => {
  // A real trade rather than a right answer, so it is a setting - which is how
  // the original has it too. Taking the mouse gets the wheel and clickable
  // things; leaving it keeps the terminal's own drag-to-select.
  test("is on by default for clickable controls; explicit off is preserved", () => {
    expect(defaults().mouse).toBe(true)
  })

  test("survives being written and read back", () => {
    expect(normalise({ mouse: true }).mouse).toBe(true)
    expect(normalise({ mouse: false }).mouse).toBe(false)
  })

  test("anything that is not a boolean falls back rather than being truthy", () => {
    expect(normalise({ mouse: "yes" }).mouse).toBe(true)
    expect(normalise({ mouse: 1 }).mouse).toBe(true)
    expect(normalise({}).mouse).toBe(true)
  })

  test("mouse is a setting, not a command", () => {
    expect(runCommand("/mouse").kind).toBe("message")
    expect(COMMANDS.some((c) => c.name === "/mouse")).toBe(false)
  })
})

/**
 * Effort only reaches models that reason.
 *
 * A provider handed a reasoning_effort it does not understand can reject the
 * whole request, so a preference must never be able to break a model it was
 * not about.
 */
describe("choosing how hard a model thinks", () => {
  const reasoner = { id: "r", label: "Reasoner", reasoning: true, contextWindow: 128000 }
  const plain = { id: "p", label: "Plain", contextWindow: 128000 }

  test("auto sends nothing at all", () => {
    expect(effortFor(reasoner, "auto")).toBeUndefined()
    expect(effortFor(plain, "auto")).toBeUndefined()
  })

  test("a level reaches a reasoning model", () => {
    expect(effortFor(reasoner, "low")).toBe("low")
    expect(effortFor(reasoner, "medium")).toBe("medium")
    expect(effortFor(reasoner, "high")).toBe("high")
  })

  test("and never reaches one that does not reason", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(effortFor(plain, level)).toBeUndefined()
    }
  })

  test("nonsense is not forwarded either", () => {
    expect(effortFor(reasoner, "maximum")).toBeUndefined()
    expect(effortFor(reasoner, "")).toBeUndefined()
  })

  test("/effort refuses a level nobody has", () => {
    const result = runCommand("/effort maximum")
    expect(result.kind).toBe("message")
    expect(result.kind === "message" && result.text).toContain("unknown effort")
  })

  test("/effort with a real level asks for it", () => {
    expect(runCommand("/effort high")).toEqual({ kind: "effort", level: "high" })
    expect(runCommand("/effort auto")).toEqual({ kind: "effort", level: "auto" })
  })

  test("bare /effort asks for the picker too", () => {
    expect(runCommand("/effort")).toEqual({ kind: "effort", level: undefined })
  })

  test("a model says whether it takes effort, and reasoning is only the default guess", () => {
    // Declared wins, so a model that streams thinking but takes no direction
    // on it can say so without lying about reasoning.
    expect(takesEffort({ id: "a", label: "A", contextWindow: 1, reasoning: true })).toBe(true)
    expect(takesEffort({ id: "b", label: "B", contextWindow: 1 })).toBe(false)
    expect(takesEffort({ id: "c", label: "C", contextWindow: 1, reasoning: true, effort: false })).toBe(false)
    expect(takesEffort({ id: "d", label: "D", contextWindow: 1, effort: true })).toBe(true)
  })
})

describe("removing a key without typing its id", () => {
  test("bare /disconnect asks for the picker instead of printing usage", () => {
    expect(runCommand("/disconnect")).toEqual({ kind: "disconnect", provider: undefined })
  })

  test("naming one still works", () => {
    expect(runCommand("/disconnect tripo")).toEqual({ kind: "disconnect", provider: "tripo" })
  })
})
