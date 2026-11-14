/** Rows actually drawn below the transcript, including the toolbar. */
export function footerHeight(parts: {
  prompt: number
  palette?: number
  plan?: number
  overlay?: number
  pending?: number
  queued?: boolean
  images?: boolean
  scrolled?: boolean
  /** Rows above the composer's top rule: the working line, and a status message. */
  notice?: number
}) {
  return 4 + parts.prompt + (parts.notice ?? 0) + (parts.palette ?? 0) + (parts.plan ?? 0) +
    (parts.overlay ?? 0) + (parts.pending ?? 0) +
    Number(Boolean(parts.queued)) + Number(Boolean(parts.images)) + Number(Boolean(parts.scrolled))
}
