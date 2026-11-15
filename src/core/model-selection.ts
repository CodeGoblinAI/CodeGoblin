import { cliAuthStatus } from "./cli-status"
import { PROVIDERS, resolveSelection, type Selection } from "./providers"

/** An explicit startup choice may need the official CLI catalog first. */
export async function resolveStartupModel(input?: string, refresh = cliAuthStatus) {
  const selected = resolveSelection(input)
  if (selected) return selected
  const provider = PROVIDERS[input?.split("/")[0] ?? ""]
  if (!provider?.cli) return undefined
  await refresh(provider.id)
  return resolveSelection(input)
}

/**
 * The model to open on when none was asked for: the one used last, so reopening the app carries on where it
 * was left instead of going back to the built-in default. A model that is gone (a provider removed, a local
 * file deleted) is passed over for the next most recent; with nothing remembered, the default.
 */
export async function lastUsedModel(recents: string[], resolve: (id?: string) => Promise<Selection | undefined> = resolveStartupModel): Promise<Selection | undefined> {
  for (const [index, id] of recents.slice(0, 6).entries()) {
    // Only the newest is worth waiting on an official CLI's catalog for.
    const found = index === 0 ? await resolve(id).catch(() => undefined) : resolveSelection(id)
    if (found) return found
  }
  return resolve(undefined)
}
