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
      <svg
        aria-hidden="true"
        class={imageClass[size()]}
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          color: "var(--v2-icon-icon-accent, var(--icon-interactive-base, #9adb35))",
        }}
      >
        <path
          d="M183 110h146l24 64 86 20c15 4 23 21 17 35l-39 87c-5 12-18 18-30 15l-57-13-20 84c-3 13-15 22-29 20l-87-10c-10-1-19-8-23-18l-31-73-49-35c-7-5-12-13-13-22l-10-87c-2-14 8-27 22-29l78-10 19-58Z"
          fill="currentColor"
        />
        <path
          d="M177 242c0-10 8-18 18-18h36c10 0 18 8 18 18v51c0 11-9 20-20 19l-35-3c-10-1-17-9-17-19v-48Zm161-18c10 0 18 8 18 18v42c0 10-7 18-17 19l-31 4c-11 1-20-7-20-18v-47c0-10 8-18 18-18h32Z"
          fill="var(--v2-background-bg-deep, var(--background-stronger, #030703))"
        />
      </svg>
    </div>
  )
}
