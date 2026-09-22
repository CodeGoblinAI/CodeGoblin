/** Only controls that cannot replace the active conversation run mid-turn.
 * Everything else (including skill/custom prompts) uses the follow-up queue.
 */
export function isLiveCommand(text: string): boolean {
  return /^\/(?:approvals|mode|help|status|usage|theme|thinking|mouse|effort|settings|diff|quit|exit)(?:\s|$)/i.test(text.trim())
}
