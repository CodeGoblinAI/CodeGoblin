const sizeClass = {
  sm: "size-14",
  md: "size-16",
  lg: "size-20",
} as const

const imageClass = {
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
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
      <div class="absolute left-1 top-1 size-1.5 rounded-[2px] bg-[#62f56e]" />
      <div class="absolute bottom-1 right-1 h-1.5 w-4 rounded-[2px] bg-[#f5c84b]" />
      <div class="grid size-[72%] place-items-center rounded-[6px] border border-[#214f24] bg-[#071107]">
        <img src="/favicon.svg" alt="" class={`${imageClass[size()]} object-contain [image-rendering:pixelated]`} />
      </div>
    </div>
  )
}
