import "@google/model-viewer"
import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js"

// The <model-viewer> web component isn't part of Solid's built-in JSX types.
// Co-locate the augmentation with its only usage so the declaration is loaded
// wherever this module is compiled — CI's `tsgo -b` (composite/rootDir-enforced)
// doesn't pick up a standalone .d.ts reached via a cross-package reference.
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": JSX.HTMLAttributes<HTMLElement> & {
        src?: string
        alt?: string
        "camera-controls"?: boolean
        "auto-rotate"?: boolean
        "shadow-intensity"?: string
        "interaction-prompt"?: string
        loading?: "auto" | "lazy" | "eager"
      }
    }
  }
}

export type CodeGoblinModelViewerProps = {
  src: string
  directory?: string
  alt?: string
}

export const CodeGoblinModelViewer: Component<CodeGoblinModelViewerProps> = (props) => {
  const [objectUrl, setObjectUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)

  createEffect(() => {
    const src = props.src
    const directory = props.directory
    if (!src) return

    let cancelled = false
    setLoading(true)
    setError(undefined)

    void (async () => {
      try {
        const headers: Record<string, string> = {}
        if (directory) headers["x-opencode-directory"] = directory
        const response = await fetch(src, { credentials: "same-origin", headers })
        if (!response.ok) throw new Error(`Could not load 3D model (${response.status}).`)
        const contentType = response.headers.get("content-type") ?? ""
        if (contentType.includes("text/html") || contentType.includes("application/json")) {
          throw new Error("Server returned an error page instead of a GLB file.")
        }
        const blob = await response.blob()
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        setObjectUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return url
        })
        setError(undefined)
      } catch (cause) {
        if (cancelled) return
        setObjectUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return undefined
        })
        setError(cause instanceof Error ? cause.message : "Could not load 3D preview.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    onCleanup(() => {
      cancelled = true
      setObjectUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return undefined
      })
    })
  })

  return (
    <>
      <Show when={loading() && !objectUrl()}>
        <div data-slot="codegoblin-3d-preview-loading">Loading 3D preview…</div>
      </Show>
      <Show when={error()}>
        {(message) => <div data-slot="codegoblin-3d-preview-error">{message()}</div>}
      </Show>
      <Show when={objectUrl()}>
        {(url) => (
          <model-viewer
            src={url()}
            alt={props.alt ?? "Generated 3D model"}
            camera-controls
            auto-rotate
            shadow-intensity="1"
            interaction-prompt="none"
            loading="eager"
          />
        )}
      </Show>
    </>
  )
}
