const sizeClass = {
  sm: "size-14",
  md: "size-16",
  lg: "size-20",
} as const

const imageClass = {
  sm: "size-11",
  md: "size-13",
  lg: "size-17",
} as const

export function CodeGoblinLogoMark(props: { size?: keyof typeof sizeClass; class?: string }) {
  const size = () => props.size ?? "md"

  return (
    <div
      data-component="codegoblin-logo-mark"
      class={[
        "relative grid shrink-0 place-items-center rounded-[8px] border border-v2-border-border-focus bg-v2-background-bg-deep",
        "shadow-[0_0_0_1px_color-mix(in_srgb,var(--v2-border-border-focus)_8%,transparent),0_0_24px_color-mix(in_srgb,var(--v2-border-border-focus)_16%,transparent)]",
        sizeClass[size()],
        props.class,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        aria-hidden="true"
        class={imageClass[size()]}
        style={{
          "background-color": "var(--v2-icon-icon-accent, var(--icon-interactive-base, #9adb35))",
          "mask-image": "url(/codegoblin-logo.png)",
          "mask-position": "center",
          "mask-repeat": "no-repeat",
          "mask-size": "contain",
          "-webkit-mask-image": "url(/codegoblin-logo.png)",
          "-webkit-mask-position": "center",
          "-webkit-mask-repeat": "no-repeat",
          "-webkit-mask-size": "contain",
        }}
      />
    </div>
  )
}
