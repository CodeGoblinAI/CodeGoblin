/**
 * What does a setting actually put on the wire?
 *
 * Every outgoing request is intercepted and printed rather than sent, so this
 * costs nothing and reaches no provider. The point is to see the body Tripo
 * and ElevenLabs would have been handed, because "the setting is stored" and
 * "the setting is sent" are different claims and only the second one matters.
 */
import { runMedia } from "../src/core/media"

const seen: { url: string; body: unknown }[] = []
const real = globalThis.fetch

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  let body: unknown = init?.body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      /* leave it as text */
    }
  }
  seen.push({ url, body })
  // Enough of an answer to get past the first check, then a terminal status
  // so nothing polls. We want the request, not the round trip.
  const payload = url.includes("/task/")
    ? { code: 0, data: { status: "cancelled" }, message: "probe" }
    : { code: 0, data: { task_id: "probe" } }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}) as typeof fetch

const cwd = process.cwd()

async function show(title: string, run: () => Promise<unknown>) {
  seen.length = 0
  await run().catch(() => {})
  console.log("\n=== " + title + " ===")
  for (const call of seen) {
    if (!call.url.includes("tripo") && !call.url.includes("elevenlabs")) continue
    console.log(call.url)
    console.log(JSON.stringify(call.body, null, 2))
  }
  if (!seen.some((c) => c.url.includes("tripo") || c.url.includes("elevenlabs"))) {
    console.log("(no provider call - " + seen.map((c) => c.url).join(", ") + ")")
  }
}

await show("3D with nothing set", () =>
  runMedia("model3d", "/model3d a small stone bridge", cwd, { provider: "tripo", model: "text-to-model" }, {}),
)

await show("3D with quads, no texture, detailed geometry, 20k faces, P1", () =>
  runMedia(
    "model3d",
    "/model3d a small stone bridge",
    cwd,
    { provider: "tripo", model: "text-to-model" },
    // Keyed to the model, the way media.json holds them now. The old global
    // keys would match nothing and this probe would quietly show an empty
    // request - which is exactly the thing it exists to catch.
    {
      "tripo/text-to-model:3d.topology": "quad",
      "tripo/text-to-model:3d.texture": "off",
      "tripo/text-to-model:3d.geometry-quality": "detailed",
      "tripo/text-to-model:3d.faces": "20000",
      "tripo/text-to-model:3d.version": "P1-20260311",
    },
  ),
)

await show("audio with nothing set", () =>
  runMedia("audio", "/audio hello there", cwd, { provider: "elevenlabs", model: "eleven_multilingual_v2" }, {}),
)

await show("audio at speed 1.2, stability 0, boost off", () =>
  runMedia(
    "audio",
    "/audio hello there",
    cwd,
    { provider: "elevenlabs", model: "eleven_multilingual_v2" },
    {
      "elevenlabs/eleven_multilingual_v2:audio.speed": "1.2",
      "elevenlabs/eleven_multilingual_v2:audio.stability": "0",
      "elevenlabs/eleven_multilingual_v2:audio.boost": "off",
      "elevenlabs/eleven_multilingual_v2:audio.format": "mp3_22050_32",
    },
  ),
)

// ---------------------------------------------------------------------------
// And now with whatever is actually on disk, rather than a literal written
// here - which is the only version of this that proves anything about the
// settings someone chose in the terminal or the browser.
const { loadMedia } = await import("./../src/core/media-settings")
const stored = await loadMedia()
console.log("\n=== stored settings ===")
console.log(JSON.stringify(stored))

await show("3D as stored", () =>
  runMedia("model3d", "/model3d a small stone bridge", cwd, { provider: "tripo", model: "text-to-model" }, stored),
)
await show("audio as stored", () =>
  runMedia("audio", "/audio hello there", cwd, { provider: "elevenlabs", model: "eleven_multilingual_v2" }, stored),
)

globalThis.fetch = real
