/** Only controls that cannot replace the active conversation run mid-turn.
 * Everything else (including skill/custom prompts) uses the follow-up queue.
 */
export function isLiveCommand(text: string): boolean {
  return /^\/(?:approvals|mode|help|status|local|usage|balance|credits|account|theme|thinking|mouse|effort|settings|diff|copy|export|quit|exit)(?:\s|$)/i.test(text.trim())
}
