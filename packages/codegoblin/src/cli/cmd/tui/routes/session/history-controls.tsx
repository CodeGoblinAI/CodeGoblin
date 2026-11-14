import type { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"

export function HistoryControls(props: {
  scroll: () => ScrollBoxRenderable
  sessionID: string
  page?: { cursor?: string; loading: boolean; error?: string }
  onLoadOlder: () => Promise<void>
  onSearch: () => void
  /** The keys that jump to the bottom (session.last), shown on the button. */
  shortcut?: string
}) {
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [away, setAway] = createSignal(false)
  // Output arrived below while scrolled up: the button says so.
  const [fresh, setFresh] = createSignal(false)
  let lastHeight = 0
  const [width, setWidth] = createSignal(0)
  let anchor: { id: string; offset: number } | undefined
  let restore: (() => void) | undefined

  const capture = () => {
    const child = props
      .scroll()
      .getChildren()
      .find((child) => child.id.startsWith("msg_") && child.y + child.height > props.scroll().viewport.y)
    return child ? { id: child.id, offset: child.y - props.scroll().viewport.y } : undefined
  }
  const refresh = () => {
    if (props.scroll().isDestroyed) return
    const height = props.scroll().scrollHeight
    // Content grew while away, and it was not older history going in above: new output below.
    if (away() && height > lastHeight && !anchor && !props.page?.loading) setFresh(true)
    lastHeight = height
    setAway(height - props.scroll().viewport.height - props.scroll().scrollTop > 1)
    if (!away()) setFresh(false)
  }
  const latest = () => {
    anchor = undefined
    props.scroll().scrollTo(props.scroll().scrollHeight)
    refresh()
  }
  const load = async () => {
    if (props.page?.loading) return
    const sessionID = props.sessionID
    anchor = capture()
    try {
      await props.onLoadOlder()
      if (props.scroll().isDestroyed || props.sessionID !== sessionID) return
      // Measure after layout, not after an arbitrary delay. New messages can
      // arrive during the fetch, so anchor to a message rather than total height.
      restore = () => {
        if (restore) renderer.removePostProcessFn(restore)
        restore = undefined
        if (props.scroll().isDestroyed || props.sessionID !== sessionID) return
        const child =
          anchor &&
          props
            .scroll()
            .getChildren()
            .find((child) => child.id === anchor!.id)
        if (child && anchor) props.scroll().scrollBy(child.y - props.scroll().viewport.y - anchor.offset)
        anchor = undefined
        refresh()
      }
      renderer.addPostProcessFn(restore)
      renderer.requestRender()
    } catch {
      anchor = undefined
      // The sync store retains the cursor and error for an explicit retry.
      refresh()
    }
  }
  const changed = () => {
    if (anchor) anchor = capture()
    refresh()
    if (away() && props.scroll().scrollTop <= 2 && props.page?.cursor && !props.page.loading && !props.page.error)
      void load()
  }

  onMount(() => {
    const scroll = props.scroll()
    lastHeight = scroll.scrollHeight
    // Messages arriving below change the content's height without a scroll or
    // resize event, so the height is compared after each frame instead.
    const watch = () => {
      if (!scroll.isDestroyed && scroll.scrollHeight !== lastHeight) refresh()
    }
    renderer.addPostProcessFn(watch)
    scroll.verticalScrollBar.on("change", changed)
    scroll.content.on("resized", refresh)
    scroll.viewport.on("resized", refresh)
    refresh()
    onCleanup(() => {
      scroll.verticalScrollBar.off("change", changed)
      scroll.content.off("resized", refresh)
      scroll.viewport.off("resized", refresh)
      renderer.removePostProcessFn(watch)
      if (restore) renderer.removePostProcessFn(restore)
    })
  })
  createEffect(
    on(
      () => props.sessionID,
      () => {
        anchor = undefined
        refresh()
      },
    ),
  )

  return (
    <Show when={away() || props.page?.loading || props.page?.error}>
      <box
        id="history-controls"
        flexDirection="row"
        flexShrink={0}
        height={1}
        onSizeChange={function () {
          setWidth(this.width)
        }}
      >
        <box flexGrow={1} flexBasis={0} flexDirection="row">
          <Show when={width() >= 65}>
            <text id="history-search" fg={theme.textMuted} onMouseUp={props.onSearch}>
              Search /search
            </text>
          </Show>
        </box>
        {/* Centred and filled, as Claude Code draws it, with the keys that do the same. */}
        <Show when={away()}>
          <text
            id="history-latest"
            fg={fresh() ? theme.background : theme.text}
            bg={fresh() ? theme.accent : theme.backgroundElement}
            onMouseUp={latest}
          >
            {" " +
              (fresh() ? "New output · " : "") +
              "Jump to bottom" +
              (props.shortcut ? ` (${props.shortcut})` : "") +
              " ↓ "}
          </text>
        </Show>
        <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end">
          <Show when={props.page?.cursor || props.page?.error}>
            <text
              id="history-older"
              fg={props.page?.error ? theme.error : theme.textMuted}
              onMouseUp={() => void load()}
            >
              {props.page?.loading ? "Loading history…" : props.page?.error ? "Retry older" : "↑ Older messages"}
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}
