import { apiKey } from "@/core/auth"

/**
 * The API key for a connected provider, for the generators.
 *
 * This used to parse `auth.json` itself, which made it a second answer to a
 * question `core/auth` already answers - and a narrower one. It read the file
 * and nothing else, so `TRIPO_API_KEY` in the environment worked for a
 * conversation and did not work for a generation, with nothing to explain the
 * difference. Now there is one resolver and both paths get the same answer.
 *
 * Still async: the generators await it, and keeping the shape means they did
 * not have to change to gain the environment.
 *
 * @param provider provider id as stored in auth.json, e.g. "tripo" or "google"
 */
export async function readConnectedProviderKey(provider: string): Promise<string | undefined> {
  return apiKey(provider)
}
