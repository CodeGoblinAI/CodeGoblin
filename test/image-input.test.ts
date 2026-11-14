import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { droppedImages, expandMentions, imageSize, typedImagePaths } from "../src/core/mention"
import { builtInVision } from "../src/core/catalog"
import { PROVIDERS, acceptsImages, applyCatalogVision, resolveSelection } from "../src/core/providers"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const B = String.fromCharCode(92)
const temp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

test("a full path or a quoted path to a picture is found; a bare relative one and a URL are not", () => {
  expect(typedImagePaths(`what is in C:${B}Users${B}me${B}Desktop${B}shot 1.png?`)).toEqual([`C:${B}Users${B}me${B}Desktop${B}shot 1.png`])
  expect(typedImagePaths(`look at "C:${B}a b${B}x.jpg" and 'rel/y.webp'`)).toEqual([`C:${B}a b${B}x.jpg`, "rel/y.webp"])
  expect(typedImagePaths("see /home/me/a.png. and ~/b.jpeg, ok")).toEqual(["/home/me/a.png", "~/b.jpeg"])
  expect(typedImagePaths("rename assets/logo.png to logo2.png")).toEqual([])
  expect(typedImagePaths("https://example.com/a.png")).toEqual([])
})

test("a picture outside the project, named by its full path, is attached to the message", async () => {
  const root = temp("cg-img-root-"), outside = temp("cg img outside-")
  const file = path.join(outside, "screen shot.png")
  fs.writeFileSync(file, PNG)
  const sent = await expandMentions("what is in " + file + "?", root)
  expect(sent.images.map((image) => image.name)).toEqual(["screen shot.png"])
  expect(sent.images[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
  // A path that is not there stays plain text.
  expect((await expandMentions("what is in " + path.join(outside, "gone.png"), root)).images).toEqual([])
})

test("dropped pictures are attached from anywhere, quoted or not; anything else is left to be text", async () => {
  const root = temp("cg-img-root-"), outside = temp("cg-img-drop-")
  const a = path.join(outside, "a b.png"), b = path.join(outside, "c.png"), text = path.join(outside, "notes.txt")
  for (const file of [a, b]) fs.writeFileSync(file, PNG)
  fs.writeFileSync(text, "hello")
  expect((await droppedImages(`"${a}"`, root))?.map((image) => image.name)).toEqual(["a b.png"])
  expect((await droppedImages(a, root))?.map((image) => image.name)).toEqual(["a b.png"])
  expect((await droppedImages(`"${a}" ${b}`, root))?.map((image) => image.name)).toEqual(["a b.png", "c.png"])
  expect(await droppedImages(`"${a}" "${text}"`, root)).toBeUndefined()
  expect(await droppedImages(path.join(outside, "missing.png"), root)).toBeUndefined()
  expect(await droppedImages("logo.png", root)).toBeUndefined()
})

test("a picture's size is read from its header", () => {
  expect(imageSize(PNG)).toEqual({ width: 1, height: 1 })
  expect(imageSize(Buffer.from("not a picture at all, just text"))).toBeUndefined()
})

test("the models the catalog says take pictures are ones a picture is sent to", () => {
  for (const id of ["deepseek/deepseek-v4-flash", "zai/glm-5.3-flash", "moonshotai/kimi-k3", "moonshotai/kimi-k2.6"]) expect(acceptsImages(resolveSelection(id)!)).toBe(true)
  expect(acceptsImages(resolveSelection("zai/glm-5.3")!)).toBe(false)
})

test("the catalog turns vision on for a built-in model, and never off", () => {
  const raw = { zai: { models: { a: { id: "glm-5.3", modalities: { input: ["text", "image"] } }, b: { id: "glm-5.3-flash", modalities: { input: ["text"] } } } }, nobody: { models: { x: { id: "x", modalities: { input: ["image"] } } } } }
  expect(builtInVision(raw)).toEqual({ zai: ["glm-5.3"] })
  const model = PROVIDERS.zai!.models.find((each) => each.id === "glm-5.3")!
  const before = model.capabilities
  try {
    expect(applyCatalogVision(builtInVision(raw))).toBe(1)
    expect(model.capabilities?.input?.image).toBe(true)
    expect(PROVIDERS.zai!.models.find((each) => each.id === "glm-5.3-flash")!.capabilities?.input?.image).toBe(true)
    expect(applyCatalogVision(builtInVision(raw))).toBe(0)
  } finally { model.capabilities = before }
  expect(builtInVision(null)).toEqual({})
})
