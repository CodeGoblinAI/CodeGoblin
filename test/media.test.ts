import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import {
  promptFrom,
  describeMedia,
  withinMediaOutput,
  MEDIA_KINDS,
  MEDIA_OUTPUT_DIR,
  type MediaResult,
} from "../src/core/media"
import { runCommand, COMMANDS } from "../src/core/commands"

const root = path.join(os.tmpdir(), "cg-media-root")

describe("what the media server will hand back", () => {
  // The first version of the file route served anything inside the working
  // directory. That included .git/config, which quite often carries a token in
  // a remote URL, so the rule is pinned here rather than trusted.
  test("serves generated media", () => {
    for (const target of [
      MEDIA_OUTPUT_DIR + "/images/a.png",
      MEDIA_OUTPUT_DIR + "/models/b.glb",
      MEDIA_OUTPUT_DIR + "/audio/c.mp3",
      path.join(root, MEDIA_OUTPUT_DIR, "images", "d.png"),
    ]) {
      expect([target, withinMediaOutput(root, target)]).toEqual([target, true])
    }
  })

  test("refuses everything else in the tree", () => {
    for (const target of [
      ".git/config",
      "src/core/auth.ts",
      "package.json",
      MEDIA_OUTPUT_DIR + "/../.git/config",
      MEDIA_OUTPUT_DIR + "/../../secrets.txt",
      "",
      ".",
    ]) {
      expect([target, withinMediaOutput(root, target)]).toEqual([target, false])
    }
  })

  test("refuses the output directory itself, which is not a file", () => {
    expect(withinMediaOutput(root, MEDIA_OUTPUT_DIR)).toBe(false)
  })

  test("refuses paths that climb out entirely", () => {
    expect(withinMediaOutput(root, "../elsewhere/a.png")).toBe(false)
    expect(withinMediaOutput(root, path.join(os.tmpdir(), "elsewhere", "a.png"))).toBe(false)
  })
})

describe("reading the command line", () => {
  test("takes the command word off the front", () => {
    expect(promptFrom("/audio hello there", "/audio")).toBe("hello there")
    expect(promptFrom("  /audio  hello  ", "/audio")).toBe("hello")
    expect(promptFrom("/AUDIO hello", "/audio")).toBe("hello")
  })

  test("leaves text that is not a command alone", () => {
    expect(promptFrom("hello there", "/audio")).toBe("hello there")
  })

  test("an empty prompt stays empty rather than becoming the command", () => {
    expect(promptFrom("/audio", "/audio")).toBe("")
  })
})

describe("describing a result", () => {
  const base: MediaResult = { ok: true, message: "done", output: "codegoblin-output/images/a.png" }

  test("names the file that was written", () => {
    expect(describeMedia({ ...base, model: "grok" })).toContain("codegoblin-output/images/a.png")
    expect(describeMedia({ ...base, model: "grok" })).toContain("via grok")
  })

  test("includes a cost when there is one", () => {
    expect(describeMedia({ ...base, cost: 0.042 })).toContain("$0.0420")
    expect(describeMedia({ ...base, cost: 0 })).not.toContain("$")
  })

  // A dry run writes nothing, so naming a file would describe something that
  // is not there.
  test("a dry run says what would have happened instead of naming a file", () => {
    const dry = describeMedia({ ...base, dryRun: true, message: "Image dry run OK. Would generate..." })
    expect(dry).toBe("Image dry run OK. Would generate...")
    expect(dry).not.toContain("codegoblin-output")
  })

  test("a failure is reported as itself", () => {
    expect(describeMedia({ ok: false, message: "no key for xai" })).toBe("no key for xai")
  })
})

describe("the media commands", () => {
  test("all three exist", () => {
    expect(MEDIA_KINDS.map((entry) => entry.command)).toEqual(["/image", "/audio", "/model3d"])
  })

  // The original does not advertise these either. You pick an image model and
  // type; the command only exists so flags like --output have somewhere to
  // live. Listing it taught people a command they should never need.
  test("none of them is an advertised command", () => {
    for (const entry of MEDIA_KINDS) {
      expect([entry.command, COMMANDS.some((c) => c.name === entry.command)]).toEqual([entry.command, false])
    }
  })

  test("but typing one still works, flags and all", () => {
    expect(runCommand("/image --output a.png a goblin")).toEqual({
      kind: "media",
      media: "image",
      line: "/image --output a.png a goblin",
    })
  })

  test("a prompt is required, and saying so is not an error message", () => {
    for (const entry of MEDIA_KINDS) {
      const result = runCommand(entry.command)
      expect(result.kind).toBe("message")
      expect(result.kind === "message" && result.text).toContain("usage:")
    }
  })

  test("the whole line is passed through, so flags survive", () => {
    const result = runCommand("/image --provider xai a goblin reading code")
    expect(result).toEqual({ kind: "media", media: "image", line: "/image --provider xai a goblin reading code" })
  })

  test("each command maps to its own kind", () => {
    for (const entry of MEDIA_KINDS) {
      const result = runCommand(entry.command + " something")
      expect([entry.command, result.kind === "media" && result.media]).toEqual([entry.command, entry.kind])
    }
  })
})
