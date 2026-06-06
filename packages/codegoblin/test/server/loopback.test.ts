import { describe, expect, test } from "bun:test"
import { isHostOnlyHttpRequest, isLoopbackHost } from "@/server/shared/loopback"

describe("isLoopbackHost", () => {
  test("accepts localhost and loopback IPs with optional ports", () => {
    expect(isLoopbackHost("localhost:4096")).toBe(true)
    expect(isLoopbackHost("127.0.0.1:4096")).toBe(true)
    expect(isLoopbackHost("[::1]:4096")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
  })

  test("rejects remote hosts", () => {
    expect(isLoopbackHost("192.168.1.10:4096")).toBe(false)
    expect(isLoopbackHost("codegoblin.example.com")).toBe(false)
  })
})

describe("isHostOnlyHttpRequest", () => {
  test("allows loopback Host without forwarding", () => {
    expect(isHostOnlyHttpRequest({ host: "127.0.0.1:4096" })).toBe(true)
  })

  test("rejects non-loopback Host", () => {
    expect(isHostOnlyHttpRequest({ host: "10.0.0.5:4096" })).toBe(false)
  })

  test("rejects loopback Host with a non-loopback X-Forwarded-For", () => {
    expect(
      isHostOnlyHttpRequest({
        host: "127.0.0.1:4096",
        "x-forwarded-for": "203.0.113.1",
      }),
    ).toBe(false)
  })
})
