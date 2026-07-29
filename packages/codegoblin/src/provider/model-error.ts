/**
 * Single source of the "model not found" wording.
 *
 * It is needed in two shapes: from the live `ModelNotFoundError` instance, and
 * from the serialized `{ providerID, modelID, suggestions }` the CLI formatter
 * receives after the error has crossed the wire. Keeping the text here stops the
 * two from drifting.
 */
export function modelNotFoundMessage(input: {
  providerID: string
  modelID: string
  suggestions?: readonly string[]
}): string {
  const id = `${input.providerID}/${input.modelID}`

  // Local runtime models only exist while a GGUF is present on disk, so a missing
  // one is nearly always "the runtime isn't set up here" rather than a typo.
  // Saying so beats a bare not-found next to an apparently empty picker.
  if (input.providerID === "codegoblin") {
    return [
      `Local model ${id} is not installed.`,
      "Local models are discovered from the runtime models directory, so this one is either not pulled yet or the runtime directory has moved.",
      "Run `codegoblin runtime list` to see what is installed, `codegoblin runtime pull <model>` to fetch one, or pick a cloud model instead.",
    ].join(" ")
  }

  const suggestions = input.suggestions?.length ? ` Did you mean: ${input.suggestions.join(", ")}?` : ""
  return `Model ${id} not found.${suggestions}`
}
