import type { JSX } from "solid-js"

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

export {}
