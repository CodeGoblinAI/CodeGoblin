/** Only controls that cannot replace the active conversation run mid-turn.
 * Everything else (including skill/custom prompts) uses the follow-up queue.
 */
export function isLiveCommand(text: string): boolean {
  // Looking at things is always allowed: what is running in the background, an earlier message, a search.
  return /^\/(?:approvals|mode|help|status|local|usage|balance|credits|account|theme|thinking|mouse|effort|settings|diff|copy|export|quit|exit|jobs|job|bg|background|timeline|search|fold|timestamps)(?:\s|$)/i.test(text.trim())
}
