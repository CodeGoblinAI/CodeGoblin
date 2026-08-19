// Replaces @codegoblin/core/util/log with the same call shape.
type Fields = Record<string, unknown>

export function create(tags: Fields = {}) {
  const emit = (level: string, message: string, fields?: Fields) => {
    const merged = { ...tags, ...fields }
    const suffix = Object.keys(merged).length ? " " + JSON.stringify(merged) : ""
    console.error(`${level.toUpperCase()} ${message}${suffix}`)
  }
  return {
    info: (message: string, fields?: Fields) => emit("info", message, fields),
    warn: (message: string, fields?: Fields) => emit("warn", message, fields),
    error: (message: string, fields?: Fields) => emit("error", message, fields),
    debug: (_message: string, _fields?: Fields) => {},
  }
}
