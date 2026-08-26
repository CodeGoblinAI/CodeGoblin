import type { ModelID, ProviderID } from "./schema"

/**
 * Provider and model shapes.
 *
 * Ported from the previous codebase's Effect Schema structs. Nothing here
 * validates at runtime — these describe the models catalog, which is data we
 * fetch and trust. Keeping them as plain types avoids pulling Effect in for
 * what is, in practice, a type declaration.
 */

export type Modalities = {
  text: boolean
  audio: boolean
  image: boolean
  video: boolean
  pdf: boolean
}

export type CacheCost = {
  read: number
  write: number
}

export type Capabilities = {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input: Modalities
  output: Modalities
  interleaved: boolean | string
}

export type Cost = {
  input: number
  output: number
  cache: CacheCost
  tiers?: unknown[]
  experimentalOver200K?: {
    input: number
    output: number
    cache: CacheCost
  }
}

export type Limit = {
  context: number
  input?: number
  output: number
}

export type ApiInfo = {
  id: string
  url: string
  npm: string
}

export type ModelStatus = "active" | "alpha" | "beta" | "deprecated" | "retired"

export type Model = {
  id: ModelID
  providerID: ProviderID
  api: ApiInfo
  name: string
  family?: string
  capabilities: Capabilities
  cost: Cost
  limit: Limit
  status: ModelStatus
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
  variants?: Record<string, Record<string, unknown>>
}

export type Info = {
  id: ProviderID
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, Model>
}
