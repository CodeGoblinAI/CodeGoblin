import { createHash } from "node:crypto"
import {
  APICallError,
  type LanguageModelV3Middleware,
  type LanguageModelV3Prompt,
  type LanguageModelV3ReasoningPart,
} from "@ai-sdk/provider"

export function reasoningRecovery(onRecover: () => void): LanguageModelV3Middleware {
  // Keep fingerprints, not opaque provider state. The cache lives with the LLM
  // service and never changes the stored conversation or valid new reasoning.
  const expired = new Set<string>()

  function clean(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
    if (!expired.size) return prompt
    return prompt.map((message) => {
      if (message.role !== "assistant") return message
      return {
        ...message,
        content: message.content.flatMap((part) => {
          if (part.type !== "reasoning" || !reasoningKeys(part).some((key) => expired.has(key))) return [part]
          // A bare reasoning item ID is not a replacement for expired encrypted
          // state. Keep a visible summary as text, without provider metadata.
          return part.text.trim() ? [{ type: "text" as const, text: part.text }] : []
        }),
      }
    })
  }

  return {
    specificationVersion: "v3",
    async transformParams({ params }) {
      return { ...params, prompt: clean(params.prompt) }
    },
    async wrapStream({ doStream, params }) {
      try {
        return await doStream()
      } catch (error) {
        if (
          !APICallError.isInstance(error) ||
          error.statusCode !== 400 ||
          !/reasoning\b.*\bencrypted_content\b.*\bexpired\b/i.test(error.message)
        ) {
          throw error
        }

        const keys = params.prompt.flatMap((message) =>
          message.role !== "assistant"
            ? []
            : message.content.flatMap((part) =>
                part.type === "reasoning" &&
                Object.values(part.providerOptions ?? {}).some(
                  (options) => typeof options.reasoningEncryptedContent === "string",
                )
                  ? reasoningKeys(part)
                  : [],
              ),
        )
        if (!keys.length) throw error
        keys.forEach((key) => expired.add(key))
        params.prompt = clean(params.prompt)
        onRecover()
      }

      // Only an initial HTTP rejection is retried, before a stream or tool
      // execution exists. A second failure propagates without another attempt.
      return doStream()
    },
  }
}

function reasoningKeys(part: LanguageModelV3ReasoningPart) {
  return Object.entries(part.providerOptions ?? {}).flatMap(([provider, options]) =>
    ["reasoningEncryptedContent", "itemId"].flatMap((field) =>
      typeof options[field] === "string"
        ? [createHash("sha256").update(`${provider}:${field}:${options[field]}`).digest("hex")]
        : [],
    ),
  )
}
