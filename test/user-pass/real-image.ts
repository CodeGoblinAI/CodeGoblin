// Real, cheap check that a model is shown a picture (a few thousand tokens on a cheap vision model):
// 1. a picture named by its full path, outside the project, with no @;  2. a picture the model opens with read_file.
// The picture is a plain red square, so the answer is checkable. The key is read into this process's environment
// only and never printed. Run: bun test/user-pass/real-image.ts [provider/model]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
const target = process.argv[2] ?? "explabs/deepseek/deepseek-v4.1-flash"
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-image-"))

/** A solid-colour PNG, written by hand so no picture has to be kept in the repository. */
function png(size: number, [r, g, b]: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))])
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-image-root-"))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cg image desktop-"))
fs.writeFileSync(path.join(outside, "screen shot.png"), png(96, [220, 20, 20]))
fs.writeFileSync(path.join(root, "swatch.png"), png(96, [20, 60, 220]))

const { PROVIDERS, acceptsImages, resolveSelection, refreshExperientialModels } = await import("../../src/core/providers")
if (providerId === "explabs") await refreshExperientialModels()
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { expandMentions } = await import("../../src/core/mention")
const { Permissions } = await import("../../src/core/permission")
const selection = resolveSelection(target)
if (!selection) { console.log("no such model: " + target + "\nvision models here: " + PROVIDERS[providerId]?.models.filter((m) => m.capabilities?.input?.image).map((m) => m.id).slice(0, 30).join(", ")); process.exit(0) }
const seeing = acceptsImages(selection)
console.log(target + (seeing ? " is listed as able to see" : " is listed as NOT able to see"))

let failed = 0
async function turn(label: string, typed: string, expect: RegExp, maxTurns: number) {
  const mentioned = await expandMentions(typed, root)
  let text = "", tools: string[] = [], input = 0, output = 0
  try {
    for await (const event of runAgent({
      provider: selection!.provider, modelId, apiKey: secret, root, maxTurns, images: seeing,
      permissions: Permissions.withConfig(async () => "allow"),
      messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: mentioned.content, images: mentioned.images }],
    } as never)) {
      const e = event as { type: string; delta?: string; name?: string; input?: number; output?: number }
      if (e.type === "text") text += e.delta
      if (e.type === "tool_start") tools.push(e.name ?? "?")
      if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0 }
    }
  } catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  const ok = expect.test(text)
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: attached [${mentioned.images.map((i) => i.name).join(", ")}], tools [${tools.join(", ")}], ${input} in / ${output} out -> ${text.replace(/\s+/g, " ").slice(0, 160)}`)
}

await turn("a picture named by full path, outside the project", "What colour is " + path.join(outside, "screen shot.png") + " ? Answer with one word.", /red/i, 2)
await turn("a picture the model opens with read_file", "Use the read_file tool on swatch.png, then answer with one word: what colour is it?", /blue/i, 4)
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(0)
