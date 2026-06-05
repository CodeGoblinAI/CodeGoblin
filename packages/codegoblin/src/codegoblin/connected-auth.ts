import fs from "fs/promises"
import path from "path"
import { Global } from "@codegoblin/core/global"

/**
 * Reads an API key for a connected provider from the local CodeGoblin/OpenCode
 * auth store (the same `auth.json` that `/connect` writes via the Auth module).
 *
 * Plain async so the media commands (image/audio/model3d) can call it without an
 * Effect runtime. Resolves the store from {@link Global.Path.data} so it honors
 * `XDG_DATA_HOME`/`OPENCODE_TEST_HOME` instead of hardcoding `~/.local/share/opencode`.
 *
 * @param provider provider id as stored in auth.json (e.g. "tripo", "openai", "alibaba")
 * @param dataDir override for the data directory; defaults to the live data path
 * @returns the API key string, or undefined when no usable `api`-type key exists
 */
export async function readConnectedProviderKey(
  provider: string,
  dataDir: string = Global.Path.data,
): Promise<string | undefined> {
  const file = path.join(dataDir, "auth.json")
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  if (!raw) return
  try {
    const data = JSON.parse(raw)
    const item = data?.[provider]
    if (item?.type === "api" && typeof item.key === "string") return item.key
  } catch {}
  return
}
