export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@codegoblin/core/flag/flag"
import { Global } from "@codegoblin/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@codegoblin/core/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  names: string | string[],
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  // Names are listed highest-priority first (e.g. ["codegoblin", "opencode"]).
  // `up` walks leaf->root and, within each directory, returns matches in target
  // order. We reverse the whole list below so the merge that consumes it applies
  // root-first and leaf-last; combined with the target order here that makes the
  // highest-priority name and the `.jsonc` variant win.
  const list = Array.isArray(names) ? names : [names]
  const targets = list.flatMap((name) => [`${name}.jsonc`, `${name}.json`])
  return (yield* afs.up({
    targets,
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  // `.opencode` is listed before `.codegoblin` so that, at each directory level,
  // the `.codegoblin` directory is merged afterwards and wins on conflicts while
  // legacy `.opencode` directories keep working.
  const targets = [".opencode", ".codegoblin"]
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets,
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets,
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
