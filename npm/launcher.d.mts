export const PACKAGE: string
export const PROGRAMS: string[]
export function platformPackage(platform?: string, arch?: string): string | undefined
export function findProgram(from: string, name: string, platform?: string): string | undefined
export function installedBy(file: string): "npm" | "pnpm" | "bun"
export function installCommand(manager: string, version: string, platform?: string): [string, string[]]
export function newer(candidate: string, current: string): boolean
export function target(word: string | undefined, current: string, tags: Record<string, unknown>): string | undefined
