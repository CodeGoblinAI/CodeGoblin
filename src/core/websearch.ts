/**
 * Searching the web.
 *
 * The fork searches through Exa's hosted MCP endpoint, which needs no key for
 * light use; CG-Next uses the same one, so a search costs the user nothing and
 * goes nowhere new. EXA_API_KEY, when set, is passed along for higher limits.
 * One JSON-RPC call - no MCP session - the way the fork does it.
 *
 * The query leaves the machine, so the tool asks first like webfetch does,
 * and what comes back is someone else's text: the model is told to treat it
 * as information, not instructions.
 */
const ENDPOINT = "https://mcp.exa.ai/mcp"
const TIMEOUT_MS = 25_000
const MAX_TEXT = 20_000
const NEWLINE = String.fromCharCode(10)

export type SearchOptions = { numResults?: number; signal?: AbortSignal; fetch?: typeof fetch; endpoint?: string; key?: string }

/** The text of the first content item in a JSON-RPC result, from a plain JSON body or an event stream. */
export function parseSearchResponse(body: string): string | undefined {
  const fromPayload = (payload: string): string | undefined => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    try {
      const data = JSON.parse(trimmed) as { result?: { content?: { type?: string; text?: string }[] }; error?: { message?: string } }
      if (data.error) throw new Error(data.error.message || "the search service returned an error")
      return data.result?.content?.find((item) => typeof item.text === "string" && item.text)?.text
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  }
  const direct = fromPayload(body)
  if (direct) return direct
  for (const line of body.split(NEWLINE)) {
    if (!line.startsWith("data: ")) continue
    const found = fromPayload(line.slice(6))
    if (found) return found
  }
  return undefined
}

export async function searchWeb(query: string, options: SearchOptions = {}): Promise<string> {
  const text = query.trim()
  if (!text) throw new Error("give a search query")
  if (text.length > 400) throw new Error("the query is too long - search for the key words")
  const key = options.key ?? process.env.EXA_API_KEY
  const url = (options.endpoint ?? ENDPOINT) + (key ? "?exaApiKey=" + encodeURIComponent(key) : "")
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const numResults = Math.max(1, Math.min(10, Math.round(options.numResults ?? 6)))
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query: text, type: "auto", numResults, livecrawl: "fallback", contextMaxCharacters: 10_000 } },
      }),
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw new Error("stopped")
    if (timeout.aborted) throw new Error("the search timed out after 25 seconds")
    throw new Error("could not reach the search service: " + (error instanceof Error ? error.message : String(error)))
  }
  if (response.status === 429) throw new Error("the search service is rate limiting; wait a minute, or set EXA_API_KEY")
  if (!response.ok) throw new Error(`the search service answered ${response.status}`)
  const found = parseSearchResponse(await response.text())
  if (!found) return "no results - try different words"
  return found.length > MAX_TEXT ? found.slice(0, MAX_TEXT) + NEWLINE + "... (cut to the first " + MAX_TEXT.toLocaleString("en-US") + " characters)" : found
}
