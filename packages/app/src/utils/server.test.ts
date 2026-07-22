import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createFetchForServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("createFetchForServer", () => {
  test("preserves request headers and adds configured server authentication", async () => {
    let headers = new Headers()
    const request = createFetchForServer({
      server: { url: "https://example.test", username: "kit", password: "secret" },
      fetch: (async (_input, init) => {
        headers = new Headers(init?.headers)
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await request("https://example.test/codegoblin/usage", {
      headers: { "x-opencode-directory": "C:\\Users\\kit\\project" },
    })

    expect(headers.get("authorization")).toBe(`Basic ${btoa("kit:secret")}`)
    expect(headers.get("x-opencode-directory")).toBe("C:\\Users\\kit\\project")
  })

  test("refuses to send server credentials to another origin", () => {
    const request = createFetchForServer({
      server: { url: "https://example.test", password: "secret" },
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    })
    expect(() => request("https://attacker.test/collect")).toThrow("configured server origin")
  })
})
