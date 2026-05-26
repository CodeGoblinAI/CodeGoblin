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
        "relative grid shrink-0 place-items-center rounded-[8px] border border-[#62f56e] bg-[#030703]",
        "shadow-[0_0_0_1px_rgba(98,245,110,0.08),0_0_24px_rgba(98,245,110,0.16)]",
        sizeClass[size()],
        props.class,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <img src="/codegoblin-logo.png" alt="" class={`${imageClass[size()]} object-contain`} />
    </div>
  )
}
