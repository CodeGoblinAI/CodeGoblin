import { describe, expect, test } from "bun:test"
import { isPrivateAddress, htmlToText, fetchUrl } from "../src/core/webfetch"
import { Permissions, scopeOf } from "../src/core/permission"

describe("addresses a fetch tool has no business reaching", () => {
  test("refuses loopback, private ranges and link-local", () => {
    for (const address of [
      "127.0.0.1", "127.1.2.3", "0.0.0.0",
      "10.0.0.5", "172.16.4.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", // cloud metadata, the one that actually gets stolen
      "100.64.0.1", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd12::9", "fe80::1",
      "::ffff:127.0.0.1", // a loopback address wearing v6 clothes
    ]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true])
    }
  })

  test("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, false])
    }
  })

  test("treats anything it cannot parse as private", () => {
    for (const address of ["", "not-an-address", "1.2.3", "1.2.3.4.5", "999.1.1.1"]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true])
    }
  })
})

describe("refusing before connecting", () => {
  test("takes only http and https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi"]) {
      await expect(fetchUrl(url)).rejects.toThrow("only http and https")
    }
  })

  test("says so when it is not a URL at all", async () => {
    await expect(fetchUrl("just some words")).rejects.toThrow("not a URL")
  })

  test("refuses a hostname that resolves into the private network", async () => {
    await expect(fetchUrl("http://localhost:4400/api/commands")).rejects.toThrow("private address")
  })

  test("refuses a literal private address", async () => {
    await expect(fetchUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow("private address")
  })
})

describe("turning a page into something readable", () => {
  test("drops scripts, styles and comments entirely", () => {
    const html = "<p>keep</p><script>steal()</script><style>.a{}</style><!-- hidden -->"
    const text = htmlToText(html)
    expect(text).toContain("keep")
    expect(text).not.toContain("steal")
    expect(text).not.toContain(".a{}")
    expect(text).not.toContain("hidden")
  })

  test("keeps block structure as line breaks", () => {
    expect(htmlToText("<h1>Title</h1><p>One</p><p>Two</p>").split(String.fromCharCode(10))).toEqual([
      "Title", "One", "Two",
    ])
  })

  test("decodes the entities that actually show up", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e</p>")).toBe('a & b <c> "d" e')
  })

  test("collapses the whitespace that markup leaves behind", () => {
    expect(htmlToText("<div>  lots\n\n   of     space  </div>")).toBe("lots of space")
  })
})

describe("what one approval covers", () => {
  test("a host at a time for webfetch, so one yes is not every yes", () => {
    expect(scopeOf("webfetch", JSON.stringify({ url: "https://example.com/a" }))).toBe("webfetch:example.com")
    expect(scopeOf("webfetch", JSON.stringify({ url: "https://example.com/b" }))).toBe("webfetch:example.com")
    expect(scopeOf("webfetch", JSON.stringify({ url: "https://evil.test/x" }))).toBe("webfetch:evil.test")
  })

  test("the whole tool for everything else", () => {
    expect(scopeOf("write_file", JSON.stringify({ path: "a.ts" }))).toBe("write_file")
    expect(scopeOf("shell", JSON.stringify({ command: "ls" }))).toBe("shell")
  })

  test("approving one host does not approve the next", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, detail) => {
      asked.push(detail)
      return detail.includes("example.com") ? "allow" : "deny"
    })

    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com/1" }))).toBe(true)
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com/2" }))).toBe(true)
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://evil.test/1" }))).toBe(false)

    // Asked once per host, not once per URL and not only once overall.
    expect(asked.length).toBe(2)
  })

  test("a write still only asks once", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "allow" })
    await permissions.check("write_file", JSON.stringify({ path: "a.ts" }))
    await permissions.check("write_file", JSON.stringify({ path: "b.ts" }))
    expect(asked).toBe(1)
  })
})

describe("a public URL that redirects into the private network", () => {
  // The interesting attack: the host you approve is fine, and the host you
  // actually reach is not. Checking only the first URL would walk straight in.
  const network = (addresses: Record<string, string[]>, pages: Record<string, Response>) => ({
    resolve: async (hostname: string) => addresses[hostname] ?? [],
    fetch: async (url: URL) => pages[url.toString()] ?? new Response("missing", { status: 404 }),
  })

  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })
  const page = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } })

  test("is refused at the hop that leaves public space", async () => {
    const net = network(
      { "public.test": ["93.184.216.34"], "inside.test": ["127.0.0.1"] },
      { "http://public.test/": redirect("http://inside.test/secrets") },
    )
    await expect(fetchUrl("http://public.test/", net)).rejects.toThrow("private address 127.0.0.1")
  })

  test("is refused even when the redirect is to a bare private address", async () => {
    const net = network(
      { "public.test": ["93.184.216.34"], "169.254.169.254": ["169.254.169.254"] },
      { "http://public.test/": redirect("http://169.254.169.254/latest/meta-data/") },
    )
    await expect(fetchUrl("http://public.test/", net)).rejects.toThrow("private address")
  })

  test("still follows an ordinary redirect between public hosts", async () => {
    const net = network(
      { "public.test": ["93.184.216.34"], "elsewhere.test": ["1.1.1.1"] },
      {
        "http://public.test/": redirect("http://elsewhere.test/final"),
        "http://elsewhere.test/final": page("the actual page"),
      },
    )
    const text = await fetchUrl("http://public.test/", net)
    expect(text).toContain("the actual page")
    expect(text).toContain("redirected via 1 hop")
  })

  test("gives up rather than following a redirect loop forever", async () => {
    const net = network(
      { "loop.test": ["1.1.1.1"] },
      { "http://loop.test/": redirect("http://loop.test/") },
    )
    await expect(fetchUrl("http://loop.test/", net)).rejects.toThrow("too many redirects")
  })

  test("refuses a redirect that changes scheme to something local", async () => {
    const net = network(
      { "public.test": ["93.184.216.34"] },
      { "http://public.test/": redirect("file:///etc/passwd") },
    )
    await expect(fetchUrl("http://public.test/", net)).rejects.toThrow("only http and https")
  })
})
