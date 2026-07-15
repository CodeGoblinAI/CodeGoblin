import stringWidth from "string-width"

export function wrappedTextHeight(value: string, columns: number) {
  const width = Math.max(1, Math.floor(columns))
  return value.split("\n").reduce((height, line) => height + wrappedLineHeight(line, width), 0)
}

function wrappedLineHeight(value: string, width: number) {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 1

  const wordWrapped = words.reduce(
    (layout, word) => {
      const wordWidth = stringWidth(word)
      if (layout.column > 0 && layout.column + 1 + wordWidth <= width) {
        layout.column += 1 + wordWidth
        return layout
      }
      if (layout.column > 0) {
        layout.rows++
        layout.column = 0
      }
      if (wordWidth <= width) {
        layout.column = wordWidth
        return layout
      }

      layout.rows += Math.ceil(wordWidth / width) - 1
      layout.column = wordWidth % width || width
      return layout
    },
    { rows: 1, column: 0 },
  ).rows
  return Math.max(wordWrapped, Math.ceil(stringWidth(value) / width))
}
