import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeText, encodeText, type TextEncoding } from "../src/core/text-edit"
import { History } from "../src/core/undo"
import { frameSafe, visibleCall, visibleControls } from "../src/core/terminal-safe"
import { displayWidth, padToWidth, truncateMiddle, truncateToWidth, wrapToWidth } from "../src/tui/width"
import { secretPathsIn } from "../src/core/secret-files"
import { isReadOnlyCommand } from "../src/core/permission"
import { globToRegExp } from "../src/core/search"
import { unfoldPastes } from "../src/core/sessions"
import { isPrivateAddress } from "../src/core/webfetch"

/**
 * Seeded property-based tests (see REVIEW.md and .claude/skills/verify/SKILL.md).
 *
 * Hand-written unit tests check the cases their author thought of; property tests
 * generate hundreds of adversarial inputs against invariants that must never break
 * (round-trip identity, idempotency, safety bounds, and representation equivalence).
 * Deterministic by default; set CG_PROP_SEED=<n> to replay or explore another seed.
 */
const SEED = Number(process.env.CG_PROP_SEED ?? 0xc0de60b1) >>> 0

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

const GLYPHS = [
  "a", "Z", "0", " ", "\t", "\n", "\r\n", "-", "_", "/", "\\", ":", ";",
  "é", "ü", "ß", "—", "…", "\ufeff", "\u200b", "e\u0301",
  "漢", "字", "日", "本", "한", "글", "🙂", "🎉", "🚀", "🪄", "שלום",
]

function randomText(rng: () => number, maxLen = 40): string {
  const len = int(rng, 0, maxLen)
  let out = ""
  for (let i = 0; i < len; i++) out += pick(rng, GLYPHS)
  return out
}

describe(`property invariants (seed=${SEED})`, () => {
  test("round-trip text encoding preserves exact code units and bytes across all 4 encodings", () => {
    const rng = mulberry32(SEED ^ 1)
    const encodings: TextEncoding[] = ["utf8", "utf8-bom", "utf16le", "utf16be"]
    for (let i = 0; i < 400; i++) {
      const text = randomText(rng, 50)
      const encoding = encodings[i % encodings.length]!
      const encoded = encodeText(text, encoding)
      const decoded = decodeText(encoded)
      expect(decoded).toBeDefined()
      // Byte round-trip always holds; a plain UTF-8 string starting with U+FEFF has the exact bytes of utf8-bom on disk.
      expect(encodeText(decoded!.text, decoded!.encoding).equals(encoded)).toBe(true)
      if (!(encoding === "utf8" && text.startsWith("\ufeff"))) {
        expect(decoded).toEqual({ text, encoding })
      }
    }
  })

  test("undo and redo restore exact bytes for any text or binary buffer", async () => {
    const rng = mulberry32(SEED ^ 2)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-prop-undo-"))
    const encodings: TextEncoding[] = ["utf8", "utf8-bom", "utf16le", "utf16be"]

    for (let i = 0; i < 120; i++) {
      let original: Buffer
      const kind = i % 6
      if (kind < 4) {
        original = encodeText(randomText(rng, 30), encodings[kind]!)
      } else if (kind === 4) {
        // Non-zero random bytes (catches 0-NUL binary buffers, PNG/JPEG/gzip-like bytes).
        const len = int(rng, 1, 64)
        original = Buffer.alloc(len)
        for (let b = 0; b < len; b++) original[b] = int(rng, 1, 255)
      } else {
        // Adversarial BOM prefixes (0xff 0xfe, 0xfe 0xff, 0xef 0xbb 0xbf) with arbitrary/odd/surrogate tails.
        const prefix = pick(rng, [[0xff, 0xfe], [0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00], [0xef, 0xbb, 0xbf]])
        const tailLen = int(rng, 0, 25)
        const tail = Buffer.alloc(tailLen)
        for (let b = 0; b < tailLen; b++) tail[b] = int(rng, 0, 255)
        original = Buffer.concat([Buffer.from(prefix), tail])
      }

      const rel = `case-${i}.dat`
      const full = path.join(root, rel)
      fs.writeFileSync(full, original)

      const history = new History()
      history.begin(`turn-${i}`)
      await history.record(root, rel)
      const replacement = Buffer.from(`modified-${i}-\n`, "utf8")
      fs.writeFileSync(full, replacement)
      history.commit(root)

      await history.undo(root)
      expect(fs.readFileSync(full).equals(original)).toBe(true)
      await history.redo(root)
      expect(fs.readFileSync(full).equals(replacement)).toBe(true)
      await history.undo(root)
      expect(fs.readFileSync(full).equals(original)).toBe(true)
    }
  })

  test("terminal sanitizers are idempotent and never leak conceal SGR, non-SGR escapes, C1 controls or bidi overrides", () => {
    const rng = mulberry32(SEED ^ 3)
    const ESC = "\x1b"
    const pieces = [
      "hello", "漢🚀", "\t", "\n", "\r", "\x07", "\x08", "\x7f", "\x9b", "\x9d", "\x9c",
      `${ESC}[31m`, `${ESC}[0m`, `${ESC}[m`, `${ESC}[8m`, `${ESC}[08m`, `${ESC}[008m`,
      `${ESC}[1;08;32m`, `${ESC}[38;5;8;08m`, `${ESC}[038;02;8;8;8;08m`,
      `${ESC}[2J`, `${ESC}[?1049h`, `${ESC}]52;c;ZXY=\x07`, `${ESC}]0;title${ESC}\\`, `${ESC}P1$r${ESC}\\`,
      "\u202e", "\u202a", "\u2066", "\u2069", "\u061c", "\u200f",
    ]
    const bidiRe = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

    for (let i = 0; i < 500; i++) {
      let input = ""
      const count = int(rng, 1, 14)
      for (let k = 0; k < count; k++) input += pick(rng, pieces)

      const vc = visibleControls(input)
      expect(visibleControls(vc)).toBe(vc)
      expect(vc.includes(ESC)).toBe(false)
      expect(vc.includes("\r")).toBe(false)

      const call = visibleCall(input)
      expect(visibleCall(call)).toBe(call)
      expect(bidiRe.test(call)).toBe(false)
      expect(call.includes(ESC)).toBe(false)

      const line = input.replace(/\n/g, " ")
      const safe = frameSafe(line)
      expect(frameSafe(safe)).toBe(safe)
      // Every remaining ESC in frameSafe output must be a pure SGR sequence with no conceal (8) style parameter.
      const stripped = safe.replace(/\x1b\[([0-9;]*)m/g, (_whole, params: string) => {
        const parts = params.split(";")
        for (let at = 0; at < parts.length; at++) {
          const code = parts[at] === "" ? -1 : Number(parts[at])
          if (code === 38 || code === 48 || code === 58) {
            const mode = parts[at + 1] === undefined || parts[at + 1] === "" ? -1 : Number(parts[at + 1])
            at += mode === 5 ? 2 : mode === 2 ? 4 : 0
            continue
          }
          expect(code).not.toBe(8)
        }
        return ""
      })
      expect(stripped.includes(ESC)).toBe(false)
    }
  })

  test("width measurement, truncation and wrapping terminate and stay within column bounds", () => {
    const rng = mulberry32(SEED ^ 4)
    for (let i = 0; i < 400; i++) {
      const plain = randomText(rng, 35).replace(/[\r\n\t]/g, " ")
      const max = int(rng, 1, 40)

      const cut = truncateToWidth(plain, max)
      expect(displayWidth(cut)).toBeLessThanOrEqual(max)

      const mid = truncateMiddle(plain, max)
      expect(displayWidth(mid)).toBeLessThanOrEqual(max)

      const padded = padToWidth(cut, max)
      expect(displayWidth(padded)).toBe(max)

      const wrapped = wrapToWidth(plain, max)
      expect(wrapped.length).toBeGreaterThanOrEqual(1)
      if (max >= 2) {
        for (const row of wrapped) expect(displayWidth(row)).toBeLessThanOrEqual(max)
      }
    }
  })

  test("cmd.exe caret obfuscation never hides secret paths or unsafe read-only flags", () => {
    const rng = mulberry32(SEED ^ 5)
    const sprinkleCarets = (word: string) =>
      [...word].map((ch, idx) => (idx > 0 && rng() < 0.45 ? "^" + ch : ch)).join("")

    const secrets = [".env", ".env.production", "auth.json", "credentials.json", ".ssh/id_ed25519", "C:\\Users\\me\\.aws\\credentials"]
    for (let i = 0; i < 200; i++) {
      const base = pick(rng, secrets)
      const suffix = pick(rng, ["", ".", " ", "::$DATA"])
      const obfuscated = sprinkleCarets(base) + suffix
      expect(secretPathsIn(`type ${obfuscated}`, "win32").length).toBeGreaterThan(0)
    }

    const unsafe = [
      ["rg", "--pre=run.bat", "needle"],
      ["rg", "--hostname-bin=run.bat", "needle"],
      ["git", "-c", "core.pager=evil", "log"],
      ["git", "-C", "C:\\other", "status"],
      ["git", "--ext-diff", "diff"],
    ]
    for (let i = 0; i < 150; i++) {
      const cmd = pick(rng, unsafe).map(sprinkleCarets).join(" ")
      expect(isReadOnlyCommand(cmd, "win32")).toBe(false)
    }
  })

  test("glob **/ respects directory boundaries and unfoldPastes never expands nested tokens", () => {
    const deep = globToRegExp("src/**/test.ts")
    expect(deep.test("src/test.ts")).toBe(true)
    expect(deep.test("src/a/b/test.ts")).toBe(true)
    expect(deep.test("src/contest.ts")).toBe(false)
    expect(deep.test("src/a/latest.ts")).toBe(false)

    const rootDeep = globToRegExp("**/env.ts")
    expect(rootDeep.test("env.ts")).toBe(true)
    expect(rootDeep.test("a/b/env.ts")).toBe(true)
    expect(rootDeep.test("myenv.ts")).toBe(false)

    const unfolded = unfoldPastes("[Pasted ~5 lines] and [Pasted ~6 lines #2]", [
      { token: "[Pasted ~5 lines]", text: "literal mention of [Pasted ~6 lines #2] inside paste 1" },
      { token: "[Pasted ~6 lines #2]", text: "SECOND" },
    ])
    expect(unfolded).toBe("literal mention of [Pasted ~6 lines #2] inside paste 1 and SECOND")
  })

  test("IPv4 privacy classification is equivalent across IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo IPv6", () => {
    const rng = mulberry32(SEED ^ 6)
    const specials = [
      [127, 0, 0, 1], [10, 4, 5, 6], [172, 20, 1, 9], [192, 168, 1, 5],
      [169, 254, 169, 254], [100, 64, 0, 1], [0, 0, 0, 0], [224, 0, 0, 1],
      [8, 8, 8, 8], [1, 1, 1, 1], [93, 184, 216, 34], [140, 82, 121, 4],
    ]
    for (let i = 0; i < 300; i++) {
      const [a, b, c, d] = i < specials.length ? specials[i]! : [int(rng, 0, 255), int(rng, 0, 255), int(rng, 0, 255), int(rng, 0, 255)]
      const v4 = `${a}.${b}.${c}.${d}`
      const hi = ((a! << 8) | b!).toString(16)
      const lo = ((c! << 8) | d!).toString(16)
      const xhi = (((a! ^ 0xff) << 8) | (b! ^ 0xff)).toString(16)
      const xlo = (((c! ^ 0xff) << 8) | (d! ^ 0xff)).toString(16)

      const expected = isPrivateAddress(v4)
      expect(isPrivateAddress(`::ffff:${v4}`)).toBe(expected)
      expect(isPrivateAddress(`::ffff:${hi}:${lo}`)).toBe(expected)
      expect(isPrivateAddress(`::${hi}:${lo}`)).toBe(expected)
      expect(isPrivateAddress(`64:ff9b::${hi}:${lo}`)).toBe(expected)
      expect(isPrivateAddress(`2002:${hi}:${lo}::1`)).toBe(expected)
      expect(isPrivateAddress(`2001:0:4136:e378:8000:63bf:${xhi}:${xlo}`)).toBe(expected)
    }
  })
})
