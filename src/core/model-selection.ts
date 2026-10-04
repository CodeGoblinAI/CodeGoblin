import { cliAuthStatus } from "./cli-status"
import { PROVIDERS, resolveSelection } from "./providers"

/** An explicit startup choice may need the official CLI catalog first. */
export async function resolveStartupModel(input?: string, refresh = cliAuthStatus) {
  const selected = resolveSelection(input)
  if (selected) return selected
  const provider = PROVIDERS[input?.split("/")[0] ?? ""]
  if (!provider?.cli) return undefined
  await refresh(provider.id)
  return resolveSelection(input)
}
