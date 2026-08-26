/**
 * Branded id types.
 *
 * The previous codebase built these on Effect's Schema.brand, which meant
 * pulling Effect in wherever an id was touched. Only `.make()` is ever used, so
 * a plain branded string gives the same type safety with no dependency.
 */
declare const brand: unique symbol

export type ProviderID = string & { readonly [brand]: "ProviderID" }
export type ModelID = string & { readonly [brand]: "ModelID" }

export const ProviderID = {
  make: (value: string) => value as ProviderID,
}

export const ModelID = {
  make: (value: string) => value as ModelID,
}
