export function ptyPaste(value: string) {
  // Bracketed paste is only safe while the payload cannot manufacture its own
  // paste terminator or submit key. Preserve useful whitespace, but remove
  // terminal control bytes and normalize carriage returns before writing it.
  return value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
}
