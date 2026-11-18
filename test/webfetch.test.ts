import { describe, expect, test } from "bun:test"
import http from "node:http"
import zlib from "node:zlib"
import { isPrivateAddress, htmlToText, fetchUrl, pinnedFetch } from "../src/core/webfetch"

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

  test("a v4 address carried inside a v6 one is judged as the v4 address, however it is written", () => {
    for (const address of [
      "::ffff:7f00:1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:c0a8:101", "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::7f00:1",
      "::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1",
      "2002:7f00:1::1", "2002:a9fe:a9fe::1",
      "2001:0000:4136:e378:8000:63bf:80ff:fffe", // Teredo XORed 127.0.0.1
      "ff02::1", "[::1]", "::ffff:127.0.0.1",
    ]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true])
    }
    for (const address of ["::ffff:808:808", "64:ff9b::808:808", "2002:0808:0808::1", "2606:4700:4700::1111"]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, false])
    }
    for (const address of ["::ffff:zz:1", "1::2::3", "1:2:3:4:5:6:7:8:9", "8.8.8.", "0x7f.0.0.1", "0177.0.0.1"]) {
      expect([address, isPrivateAddress(address)]).toEqual([address, true])
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

describe("DNS rebinding and compressed stream bounds", () => {
  test("connects to the resolved address without a second DNS lookup, and caps gzip bombs", async () => {
    const big = zlib.gzipSync(Buffer.alloc(2_000_000, "A"))
    const srv = http.createServer((req, res) => {
      if (req.url === "/bomb") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
        res.end(big)
        return
      }
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<p>host=${req.headers.host}</p>`)
    })
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
    const port = (srv.address() as { port: number }).port
    try {
      let lookups = 0
      const receivedAddresses: (string | undefined)[] = []
      const text = await fetchUrl(`http://rebind.attacker.invalid:${port}/ok`, {
        resolve: async () => {
          lookups++
          // Second lookup would return 127.0.0.1 if called!
          return lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"]
        },
        fetch: (url, init, address) => {
          receivedAddresses.push(address)
          // Route the pinned public IP to our local fixture port while proving pinnedFetch never touches DNS.
          return pinnedFetch(url, init, "127.0.0.1")
        },
      })
      expect(lookups).toBe(1)
      expect(receivedAddresses).toEqual(["93.184.216.34"])
      expect(text).toContain(`host=rebind.attacker.invalid:${port}`)

      const bombed = await fetchUrl(`http://rebind.attacker.invalid:${port}/bomb`, {
        resolve: async () => ["93.184.216.34"],
        fetch: (url, init) => pinnedFetch(url, init, "127.0.0.1"),
      })
      expect(bombed).toContain("truncated at 24000 characters")
      expect(bombed.length).toBeLessThan(25_000)
    } finally {
      srv.close()
    }
  })

  test("refuses literal IPv6 loopback with brackets", async () => {
    await expect(fetchUrl("http://[::1]:4400/api/commands")).rejects.toThrow("private address")
  })
})
