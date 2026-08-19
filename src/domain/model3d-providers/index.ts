import { tripoProvider } from "./tripo"
import type { Model3DProvider } from "./types"

const providers: Record<string, Model3DProvider> = {
  tripo: tripoProvider,
}

export function getModel3DProvider(providerID?: string): Model3DProvider {
  const id = providerID?.trim().toLowerCase() || "tripo"
  return providers[id] ?? tripoProvider
}

export type { Model3DInputImage, Model3DInputMode, Model3DProvider } from "./types"
