export function shouldUseV2NewSessionPage(input: { channel?: "dev" | "beta" | "prod"; sessionID?: string }) {
  // The V2 new-session page shipped with the 0.2.x redesign — all channels use it.
  return !input.sessionID
}
