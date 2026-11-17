/**
 * What to say when a provider refuses a request.
 *
 * The answer used to be the status and the first 300 characters of whatever came back - usually JSON,
 * sometimes a whole HTML page from a proxy. Someone who has just pasted a key, or run out of credit, then
 * read `Test returned 401. {"error":{"message":"Incorrect API key provided"}}` and had to work out what to
 * do. Each message here says what happened in a sentence and, where there is one, the next step. The status
 * stays in it ("returned 429"), because that is what people search for.
 */
function saidBy(detail: string): string {
  const text = detail.trim()
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown }
    const inner = body.error && typeof body.error === "object" ? (body.error as { message?: unknown }).message : body.error
    const said = [inner, body.message, body.detail].find((value) => typeof value === "string" && value.trim())
    if (typeof said === "string") return said.trim().slice(0, 240)
  } catch {}
  // A page, not an answer: its title or first heading, never the markup.
  if (/^\s*</.test(text)) {
    const heading = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1] ?? /<h1[^>]*>([^<]*)<\/h1>/i.exec(text)?.[1]
    return heading?.trim() ? heading.trim().slice(0, 120) : "an error page, not an answer"
  }
  return text.replace(/\s+/g, " ").slice(0, 240)
}

export function providerError(provider: { id: string; label: string }, status: number, detail: string): string {
  const said = saidBy(detail)
  const tail = said ? ": " + said.replace(/[.\s]+$/, "") + "." : "."
  const about = said.toLowerCase()
  if (status === 401 || (status === 403 && /key|auth|credential|token/.test(about))) {
    return `${provider.label} refused the key (returned ${status})${tail} /connect ${provider.id} stores a new one.`
  }
  if (status === 402 || /insufficient|balance|credit|quota exceeded|billing|payment/.test(about)) {
    return `${provider.label} says the account has run out of credit (returned ${status})${tail} Top it up with them, or switch with /model.`
  }
  if ((status === 400 || status === 413 || status === 422) && /context|too long|too many tokens|maximum.*tokens|token limit|reduce the length/.test(about)) {
    return `The conversation is too long for this model (${provider.label} returned ${status})${tail} /compact shortens it and keeps going; /clear starts again.`
  }
  if (status === 404 && /model/.test(about)) return `${provider.label} has no such model (returned 404)${tail} /model lists the ones it has.`
  if (status === 429) return `${provider.label} is turning requests away for now (returned 429)${tail} Wait a little, or switch with /model.`
  if (status >= 500) return `${provider.label} is having trouble (returned ${status})${tail} It was tried again and still failed; try once more in a moment.`
  return `${provider.label} returned ${status}${tail}`
}
