import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const unavailable =
  "[Image unavailable: this provider route rejected image input. The attachment is still saved in the conversation. Do not guess its contents. If the current request requires viewing it, explain that this route cannot view the image.]"

export async function fetchWithImageInputFallback(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const response = await fetcher(input, init)
  if (response.status !== 400 || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string")
    return response
  if (
    !new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname.endsWith(
      "/chat/completions",
    )
  )
    return response

  // Recover only from an explicit image-capability rejection, not arbitrary
  // validation errors or content-policy refusals. Successful vision is unchanged.
  const failure = Option.getOrUndefined(
    decode(
      await response
        .clone()
        .text()
        .catch(() => ""),
    ),
  )
  const error =
    isRecord(failure) && isRecord(failure.error)
      ? failure.error.message
      : isRecord(failure)
        ? failure.message
        : undefined
  if (typeof error !== "string" || !/carries an image.*selected model route accepts text only/is.test(error))
    return response
  const body = Option.getOrUndefined(decode(init.body))
  if (!isRecord(body) || !Array.isArray(body.messages)) return response
  let omitted = 0
  const messages = body.messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part: unknown) => {
        if (!isRecord(part) || part.type !== "image_url") return part
        omitted += 1
        return { type: "text", text: unavailable }
      }),
    }
  })
  if (!omitted) return response
  init.signal?.throwIfAborted()
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.delete("content-length")
  await response.body?.cancel().catch(() => {})
  // Call the underlying transport directly: at most one retry, on the same
  // model and endpoint. Never modify stored messages or cache a vision downgrade.
  return fetcher(input, { ...init, headers, body: JSON.stringify({ ...body, messages }) })
}
