import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/**
 * The web app can read and change the project and open a shell, so who may talk to it matters more than
 * anything else about it. These start the real server and ask it the things another website, another program
 * on the network, or a file the model wrote would ask.
 */
const project = fs.mkdtempSync(path.join(os.tmpdir(), "cg-websec-"))
let server: ReturnType<typeof Bun.spawn>
let base = ""
let host = ""

beforeAll(async () => {
  fs.mkdirSync(path.join(project, "codegoblin-output"), { recursive: true })
  fs.writeFileSync(path.join(project, "codegoblin-output", "report.html"), "<script>document.title='ran'</script>")
  fs.writeFileSync(path.join(project, "codegoblin-output", "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  fs.writeFileSync(path.join(project, "codegoblin-output", "picture.png"), Buffer.from("89504e470d0a1a0a", "hex"))
  fs.writeFileSync(path.join(project, "notes.txt"), "project notes")
  fs.writeFileSync(path.join(os.tmpdir(), "cg-websec-outside.txt"), "outside")
  server = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "..", "src", "cli", "main.ts"), "web"], { cwd: project, env: { ...process.env, CODEGOBLIN_DISABLE_AUTOUPDATE: "1" }, stdout: "pipe", stderr: "ignore" })
  let text = ""
  for await (const chunk of server.stdout as ReadableStream<Uint8Array>) {
    text += new TextDecoder().decode(chunk)
    const found = /http:\/\/localhost:(\d+)/.exec(text)
    if (found) { base = "http://127.0.0.1:" + found[1]; host = "127.0.0.1:" + found[1]; break }
  }
}, 40_000)

afterAll(() => { try { server.kill() } catch {} })

/** A request exactly as written, headers included - fetch will not let a test set Host or Sec-Fetch-*. */
function raw(method: string, target: string, headers: Record<string, string>, body = ""): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const [address, port] = host.split(":")
    const socket = net.connect(Number(port), address)
    let data = ""
    socket.on("connect", () => {
      const all = { host, connection: "close", ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers }
      socket.write(`${method} ${target} HTTP/1.1\r\n` + Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n" + body)
    })
    // An upgrade request keeps its connection; the answer's first lines are all that is wanted from it.
    socket.on("data", (chunk) => { data += chunk; if (headers.upgrade && data.includes("\r\n\r\n")) socket.destroy() })
    socket.on("error", reject)
    socket.on("close", () => {
      const [head = "", ...rest] = data.split("\r\n\r\n")
      const lines = head.split("\r\n")
      resolve({ status: Number(lines[0]?.split(" ")[1]), headers: Object.fromEntries(lines.slice(1).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()])), body: rest.join("\r\n\r\n") })
    })
  })
}

test("the page itself and its own requests work", async () => {
  expect((await raw("GET", "/", {})).status).toBe(200)
  expect((await raw("GET", "/api/sessions", { "sec-fetch-site": "same-origin" })).status).toBe(200)
  expect((await raw("GET", "/api/sessions", { origin: "http://" + host, "sec-fetch-site": "same-origin" })).status).toBe(200)
  // Typed into the address bar, or a program on this computer with no browser involved.
  expect((await raw("GET", "/api/sessions", { "sec-fetch-site": "none" })).status).toBe(200)
  expect((await raw("GET", "/api/sessions", {})).status).toBe(200)
})

test("another website cannot use it: not by name, not by POST, not by a plain GET", async () => {
  // A name that resolves here (DNS rebinding): the Host is not this computer.
  expect((await raw("GET", "/api/sessions", { host: "evil.example:4400" })).status).toBe(403)
  expect((await raw("POST", "/api/settings", { origin: "https://evil.example", "content-type": "application/json" }, "{}")).status).toBe(403)
  // An <img>, <script> or link on another site sends no Origin at all - only this.
  expect((await raw("GET", "/api/sessions", { "sec-fetch-site": "cross-site" })).status).toBe(403)
  expect((await raw("GET", "/api/view?path=notes.txt", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "script" })).status).toBe(403)
  // Another page on this computer, on a different port, is another site too.
  expect((await raw("GET", "/api/sessions", { "sec-fetch-site": "same-site" })).status).toBe(403)
  expect((await raw("GET", "/api/sessions", { origin: "http://localhost:3000" })).status).toBe(403)
  expect((await raw("GET", "/api/file?path=codegoblin-output/picture.png", { "sec-fetch-site": "cross-site" })).status).toBe(403)
})

test("the shell is opened by this page only", async () => {
  const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }
  expect((await raw("GET", "/api/terminal", { ...upgrade })).status).toBe(403)
  expect((await raw("GET", "/api/terminal", { ...upgrade, origin: "https://evil.example" })).status).toBe(403)
  expect((await raw("GET", "/api/terminal", { ...upgrade, origin: "http://localhost:3000" })).status).toBe(403)
  expect((await raw("GET", "/api/terminal", { ...upgrade, origin: "http://" + host, host: "evil.example" })).status).toBe(403)
})

test("a file the model wrote cannot become a page that acts as the app", async () => {
  // Generated media is served from the app's own address. An HTML or SVG file put there would otherwise run
  // its script as the app - and the app's page may open a shell.
  for (const name of ["report.html", "drawing.svg", "picture.png"]) {
    const response = await raw("GET", "/api/file?path=codegoblin-output/" + name, { "sec-fetch-site": "none" })
    expect([name, response.status]).toEqual([name, 200])
    expect([name, response.headers["content-security-policy"]]).toEqual([name, "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'"])
    expect([name, response.headers["x-content-type-options"]]).toEqual([name, "nosniff"])
  }
  const html = await raw("GET", "/api/file?path=codegoblin-output/report.html", {})
  expect(html.headers["content-type"]).toStartWith("text/plain")
  expect(html.headers["content-disposition"]).toContain("attachment")
  const png = await raw("GET", "/api/file?path=codegoblin-output/picture.png", {})
  expect(png.headers["content-type"]).toBe("image/png")
})

test("files are served from where they should be and nowhere else", async () => {
  expect((await raw("GET", "/api/file?path=notes.txt", {})).status).toBe(403)
  expect((await raw("GET", "/api/file?path=codegoblin-output/../notes.txt", {})).status).toBe(403)
  expect((await raw("GET", "/api/file?path=" + encodeURIComponent("../cg-websec-outside.txt"), {})).status).toBe(403)
  const outside = JSON.parse((await raw("GET", "/api/view?path=" + encodeURIComponent(path.join(os.tmpdir(), "cg-websec-outside.txt")), {})).body.replace(/^[0-9a-f]+\r\n|\r\n0\r\n\r\n$/g, "") || "{}")
  expect(outside.ok).toBe(false)
  const climbing = await raw("GET", "/api/view?path=" + encodeURIComponent("../cg-websec-outside.txt"), {})
  expect(climbing.body).toContain("outside the project")
  expect(climbing.body).not.toContain('"text"')
  // A conversation is a file named by its id.
  const session = await raw("GET", "/api/session?id=" + encodeURIComponent("../../auth"), {})
  expect(session.body).not.toContain("key")
})

test("the page cannot be put inside another site's frame, and loads nothing from elsewhere", async () => {
  const page = await raw("GET", "/", {})
  const policy = page.headers["content-security-policy"] ?? ""
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain("script-src 'self'")
  expect(policy).not.toContain("unsafe-eval")
  expect(policy.split(";").find((part) => part.trim().startsWith("script-src"))).not.toContain("unsafe-inline")
  expect(page.headers["x-content-type-options"]).toBe("nosniff")
  expect(page.headers["referrer-policy"]).toBe("no-referrer")
})
