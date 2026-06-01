export const CodeGoblinCommercialBoundary = {
  status: "public-scaffold-only",
  publicRepo: [
    "local cli/tui/web behavior",
    "bring-your-own-key provider flows",
    "media generation orchestration",
    "neutral interfaces for hosted features",
  ],
  privateRepo: [
    "hosted gateway routing",
    "billing and entitlements",
    "production pricing logic",
    "private provider contracts",
    "production secrets and dashboards",
  ],
  docs: "docs/MONETIZATION.md",
} as const

export function codeGoblinCommercialNotice() {
  return "CodeGoblin commercial gateway, billing, entitlement, and pricing logic lives outside this public fork; this repo exposes local-first scaffolds only."
}
