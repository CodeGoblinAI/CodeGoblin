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
}) {
  return 4 + parts.prompt + (parts.palette ?? 0) + (parts.plan ?? 0) +
    (parts.overlay ?? 0) + (parts.pending ?? 0) +
    Number(Boolean(parts.queued)) + Number(Boolean(parts.images)) + Number(Boolean(parts.scrolled))
}
