import { useFilteredList } from "@codegoblin/ui/hooks"
import { useSpring } from "@codegoblin/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  Show,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  Switch,
  Match,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@codegoblin/ui/button"
import { Dialog } from "@codegoblin/ui/dialog"
import { DockShellForm, DockTray } from "@codegoblin/ui/dock-surface"
import { Icon } from "@codegoblin/ui/icon"
import { ProviderIcon } from "@codegoblin/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@codegoblin/ui/tooltip"
import { IconButton } from "@codegoblin/ui/icon-button"
import { DropdownMenu } from "@codegoblin/ui/dropdown-menu"
import { Select } from "@codegoblin/ui/select"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, type AudioGenerationSettings, type FollowupDraft, type Model3DGenerationSettings } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { ImagePreview } from "@codegoblin/ui/image-preview"
import { useQueries } from "@tanstack/solid-query"
import { useQueryOptions } from "@/context/global-sync"
import { pathKey } from "@/utils/path-key"
import { getFilename } from "@codegoblin/core/util/path"
import { authTokenFromCredentials } from "@/utils/server"

interface PromptInputProps {
  class?: string
  variant?: "dock" | "new-session"
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}

type AudioVoiceOption = {
  id: string
  name: string
  category?: string
  description?: string
  previewUrl?: string
  labels?: Record<string, string>
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const server = useServer()
  const queryOptions = useQueryOptions()

  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const { params, tabs, view } = useSessionLayout()
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const working = createMemo(() => sync.data.session_working(params.id ?? ""))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    // Antigravity-style mid-prompt slash: true when the "/query" token is NOT the
    // whole prompt — selection then inserts a "/name " reference inline instead of
    // replacing the prompt / running the command.
    slashInline: boolean
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    slashInline: false,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return false
    const messages = sync.data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    params.id
    if (params.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )
  const agentNames = createMemo(() => local.agent.list().map((agent) => agent.name))

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .flatMap((opt) =>
        [opt.slash!, ...(opt.slashAliases ?? [])].map((trigger) => ({
          id: opt.id,
          trigger,
          title: opt.title,
          description: opt.description,
          keybind: opt.keybind,
          type: "builtin" as const,
        })),
      )

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    // Mid-prompt, only prompt-template commands (skills/config/MCP) make sense as
    // inline references — UI commands like /models would just become dead text.
    if (store.slashInline && store.popover === "slash") return custom

    return [...custom, ...builtin]
  })

  // Replace the "/partial" token at the cursor with the completed "/name "
  // reference, keeping the rest of the prompt intact (mirrors addPart's @ handling).
  const insertSlashReference = (trigger: string) => {
    const selection = window.getSelection()
    if (!selection) return
    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }
    if (selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursorPosition = getCursorPosition(editorRef)
    const rawText = prompt
      .current()
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
    const match = rawText.substring(0, cursorPosition).match(/(^|\s)\/(\S*)$/)
    if (match) {
      const start = (match.index ?? 0) + match[1].length
      setRangeEdge(editorRef, range, "start", start)
      setRangeEdge(editorRef, range, "end", cursorPosition)
    }
    const text = document.createTextNode(`/${trigger} `)
    range.deleteContents()
    range.insertNode(text)
    range.setStart(text, (text.textContent ?? "").length)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    handleInput()
  }

  // Codex-style highlight for slash references: wrap completed "/name" tokens
  // that match a known prompt-template command in a non-editable pill. Runs as
  // a pure DOM decoration after input — the parts parser recurses unknown
  // spans, so the model (and the submitted message) still sees plain text, and
  // hand-typed references highlight exactly like popover-inserted ones. Only
  // whitespace-terminated tokens are wrapped so a token still being typed at
  // the cursor is left alone.
  const highlightCommandTokens = () => {
    const triggers = new Set(
      slashCommands()
        .filter((cmd) => cmd.type === "custom")
        .map((cmd) => cmd.trigger),
    )
    if (triggers.size === 0) return

    const textNodes: Text[] = []
    const collect = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push(node as Text)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as HTMLElement
      if (el.dataset.type) return // never descend into existing pills
      for (const child of Array.from(el.childNodes)) collect(child)
    }
    for (const child of Array.from(editorRef.childNodes)) collect(child)

    const pattern = /(^|\s)\/([A-Za-z0-9._:-]+)(?=\s)/g
    let changed = false
    const hadFocus = editorRef.contains(document.activeElement) || document.activeElement === editorRef
    const cursor = hadFocus ? getCursorPosition(editorRef) : null

    for (const node of textNodes) {
      const content = node.textContent ?? ""
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      const pieces: (string | HTMLElement)[] = []
      let last = 0
      while ((match = pattern.exec(content))) {
        if (!triggers.has(match[2])) continue
        const tokenStart = match.index + match[1].length
        pieces.push(content.slice(last, tokenStart))
        const pill = document.createElement("span")
        pill.textContent = `/${match[2]}`
        pill.setAttribute("data-type", "command")
        pill.setAttribute("contenteditable", "false")
        pill.style.userSelect = "text"
        pill.style.cursor = "default"
        pieces.push(pill)
        last = tokenStart + match[2].length + 1
      }
      if (pieces.length === 0) continue
      pieces.push(content.slice(last))
      const fragment = document.createDocumentFragment()
      for (const piece of pieces) {
        if (typeof piece === "string") {
          if (piece) fragment.appendChild(document.createTextNode(piece))
        } else {
          fragment.appendChild(piece)
        }
      }
      node.replaceWith(fragment)
      changed = true
    }

    if (changed && cursor !== null) setCursorPosition(editorRef, cursor)
  }

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    const inline = store.slashInline
    closePopover()

    if (inline) {
      insertSlashReference(cmd.trigger)
      return
    }

    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      // This path bypasses handleInput, so apply the reference highlight directly.
      highlightCommandTokens()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      // Slash-reference highlight pills are pure decoration over text.
      if (el.dataset.type === "command") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }

    // Re-apply slash-reference highlighting: pills are decoration over text,
    // so rebuilds (history restore, normalization) regenerate them from content.
    highlightCommandTokens()
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const beforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = beforeCursor.match(/@(\S*)$/)
      // Slash opens anywhere in the prompt (Antigravity-style), as long as the
      // token starts the text or follows whitespace — so paths and URLs
      // ("src/foo", "https://…") never trigger it.
      const slashMatch = beforeCursor.match(/(^|\s)\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        // Inline mode = the token is NOT the entire prompt; selection inserts a
        // "/name " reference instead of replacing the prompt / running a command.
        setStore("slashInline", rawText !== `/${slashMatch[2]}`)
        slashOnInput(slashMatch[2])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    highlightCommandTokens()
    queueScroll()
  }

  // "+" menu → Mentions: drop an "@" at the end of the prompt and open the
  // file/agent picker (same path as typing "@").
  const openMentionPicker = () => {
    const existing = editorRef.textContent ?? ""
    const needsSpace = existing.length > 0 && !existing.endsWith(" ")
    setEditorText(existing + (needsSpace ? " @" : "@"))
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
      handleInput()
    })
  }

  // "+" menu → Actions: open the command palette.
  const openCommandPalette = () => command.show()

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })

  const attachFromClipboard = async () => {
    const file = await platform.readClipboardImage?.()
    if (file) await addAttachments([file])
  }

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...local.model.variant.list()])
  const accepting = createMemo(() => {
    const id = params.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
    return permission.isAutoAccepting(id, sdk.directory)
  })

  const defaultAudioSettings = (): AudioGenerationSettings => ({
    voice: "",
    outputFormat: "mp3_44100_128",
    voiceSettings: {
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0,
      speed: 1,
      useSpeakerBoost: true,
    },
    textNormalization: "auto",
  })

  const loadAudioSettings = (): AudioGenerationSettings => {
    if (typeof window === "undefined") return defaultAudioSettings()
    try {
      const saved = JSON.parse(window.localStorage.getItem("codegoblin.audio.settings") ?? "{}")
      const defaults = defaultAudioSettings()
      return {
        ...defaults,
        ...saved,
        voiceSettings: {
          ...defaults.voiceSettings,
          ...(saved.voiceSettings ?? {}),
        },
      }
    } catch {
      return defaultAudioSettings()
    }
  }

  const saveAudioSettings = (settings: AudioGenerationSettings) => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem("codegoblin.audio.settings", JSON.stringify(settings))
    } catch {}
  }

  const defaultModel3DSettings = (): Model3DGenerationSettings => ({
    modelVersion: "v3.1-20260211",
    outputFormat: "glb",
  })

  const loadModel3DSettings = (): Model3DGenerationSettings => {
    if (typeof window === "undefined") return defaultModel3DSettings()
    try {
      const saved = JSON.parse(window.localStorage.getItem("codegoblin.model3d.settings") ?? "{}")
      return { ...defaultModel3DSettings(), ...saved }
    } catch {
      return defaultModel3DSettings()
    }
  }

  const saveModel3DSettings = (settings: Model3DGenerationSettings) => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem("codegoblin.model3d.settings", JSON.stringify(settings))
    } catch {}
  }

  const confirmImageGeneration = (input: { provider: string; model: string; text: string; autoApprove: boolean }) => {
    if (input.autoApprove) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (value: boolean) => {
        if (settled) return
        settled = true
        dialog.close()
        resolve(value)
      }
      dialog.show(
        () => (
          <Dialog
            title="Generate image?"
            description="Review the selected image model before CodeGoblin spends image credits."
            action={
              <Button variant="ghost" size="normal" onClick={() => done(false)}>
                Not now
              </Button>
            }
          >
            <div class="flex flex-col gap-4 text-13-regular text-text-base">
              <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3">
                <div class="text-12-medium uppercase tracking-wide text-text-muted">Image model</div>
                <div class="mt-1 font-mono text-12-regular text-text-strong">{input.provider}/{input.model}</div>
                <div class="mt-2 text-12-regular text-text-muted">Output stays local in this chat.</div>
              </div>
              <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3">
                <div class="text-12-medium uppercase tracking-wide text-text-muted">Prompt</div>
                <div class="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap text-text-base">{input.text.slice(0, 500)}</div>
              </div>
              <div class="flex items-center justify-end gap-2">
                <Button variant="ghost" size="normal" onClick={() => done(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="normal" onClick={() => done(true)}>
                  Generate image
                </Button>
              </div>
              <div class="text-12-regular text-text-muted">
                Turn on Auto-approve image generation in Settings &gt; General to skip this confirmation.
              </div>
            </div>
          </Dialog>
        ),
        () => done(false),
      )
    })
  }

  const confirmAudioGeneration = (input: { provider: string; model: string; text: string; autoApprove: boolean }) => {
    if (input.autoApprove) return loadAudioSettings()
    return new Promise<AudioGenerationSettings | false>((resolve) => {
      const [audio, setAudio] = createStore(loadAudioSettings())
      const [voiceOptions, setVoiceOptions] = createSignal<AudioVoiceOption[]>([])
      const [voiceStatus, setVoiceStatus] = createSignal(
        input.provider.toLowerCase().includes("elevenlabs") ? "Loading ElevenLabs speakers…" : "",
      )
      const providerIsGoogle = input.provider.toLowerCase().includes("google")
      const outputFormats = providerIsGoogle
        ? ["MP3", "LINEAR16", "OGG_OPUS", "MULAW", "ALAW"]
        : ["mp3_44100_128", "mp3_44100_192", "mp3_22050_32", "wav_44100", "pcm_16000", "ulaw_8000"]
      const defaultOutputFormat = providerIsGoogle ? "MP3" : "mp3_44100_128"
      const selectedOutputFormat = outputFormats.includes(audio.outputFormat) ? audio.outputFormat : defaultOutputFormat
      let settled = false
      const done = (value: AudioGenerationSettings | false) => {
        if (settled) return
        settled = true
        if (value) saveAudioSettings(value)
        dialog.close()
        resolve(value)
      }
      const setVoiceSetting = (key: keyof AudioGenerationSettings["voiceSettings"], value: number | boolean) => {
        setAudio("voiceSettings", key, value as never)
      }
      const numberValue = (value: string) => Number.parseFloat(value)
      const voiceLabel = (voice: AudioVoiceOption) =>
        [voice.name, voice.category, voice.labels?.accent, voice.labels?.gender].filter(Boolean).join(" · ")
      const loadVoices = async () => {
        const provider = input.provider.toLowerCase()
        const supportsVoices = provider.includes("elevenlabs") || provider.includes("google")
        if (!supportsVoices) return
        const providerLabel = provider.includes("google") ? "Google" : "ElevenLabs"
        const activeServer = server.current
        const headers: Record<string, string> = {
          "x-opencode-directory": sdk.directory,
        }
        if (activeServer?.http.password) {
          headers.authorization = `Basic ${authTokenFromCredentials({
            username: activeServer.http.username,
            password: activeServer.http.password,
          })}`
        }
        const voicesUrl = `${sdk.url}/codegoblin/audio/voices?provider=${encodeURIComponent(input.provider)}`
        const result = (await fetch(voicesUrl, { headers }).then((response) =>
          response.json().then((body) => ({ response, body })).catch(() => ({ response, body: undefined })),
        )) as { response: Response; body?: { ok?: boolean; voices?: AudioVoiceOption[]; message?: string } }
        if (!result.response.ok || !result.body?.ok) {
          setVoiceStatus(result.body?.message ?? `Could not load ${providerLabel} speakers. You can still paste a voice ID.`)
          return
        }
        setVoiceOptions(result.body.voices ?? [])
        setVoiceStatus(result.body.voices?.length ? "" : `No ${providerLabel} speakers found. You can still paste a voice ID.`)
      }
      void loadVoices().catch(() => setVoiceStatus("Could not load speakers. You can still paste a voice ID."))
      dialog.show(
        () => (
          <Dialog
            title="Generate audio?"
            description="Tune the voice request before CodeGoblin spends audio credits."
            action={
              <Button variant="ghost" size="normal" onClick={() => done(false)}>
                Not now
              </Button>
            }
          >
            <div class="flex h-full flex-col gap-4 text-13-regular text-text-base">
              <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
                <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3 text-12-regular text-text-muted">
                  These audio settings are saved in this browser and reused for the next request. Turn on Auto-approve
                  audio generation in Settings &gt; General to skip this dialog.
                </div>
                <div class="grid gap-3 rounded-lg border border-border-base bg-surface-raised px-4 py-3 sm:grid-cols-2">
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Model</span>
                    <span class="font-mono text-12-regular text-text-strong">{input.provider}/{input.model}</span>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Speaker</span>
                    <select
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                      value={voiceOptions().some((voice) => voice.id === audio.voice) ? audio.voice : ""}
                      onChange={(event) => setAudio("voice", event.currentTarget.value)}
                    >
                      <option value="">Auto-pick generated voice</option>
                      {voiceOptions().map((voice) => (
                        <option value={voice.id}>{voiceLabel(voice)}</option>
                      ))}
                    </select>
                    <input
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 font-mono text-12-regular text-text-strong outline-none"
                      placeholder="or paste a voice ID"
                      value={audio.voice}
                      onInput={(event) => setAudio("voice", event.currentTarget.value.trim())}
                    />
                    <Show when={voiceStatus()}>
                      <span class="text-11-regular text-text-muted">{voiceStatus()}</span>
                    </Show>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Format</span>
                    <select
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                      value={selectedOutputFormat}
                      onChange={(event) => setAudio("outputFormat", event.currentTarget.value)}
                    >
                      {outputFormats.map((format) => (
                        <option value={format}>{format}</option>
                      ))}
                    </select>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Text normalization</span>
                    <select
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                      value={audio.textNormalization ?? "auto"}
                      onChange={(event) => setAudio("textNormalization", event.currentTarget.value as "auto" | "on" | "off")}
                    >
                      <option value="auto">Auto</option>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                </div>
              <div class="grid gap-3 rounded-lg border border-border-base bg-surface-raised px-4 py-3 sm:grid-cols-2">
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-muted">Stability · {audio.voiceSettings.stability.toFixed(2)}</span>
                  <input type="range" min="0" max="1" step="0.01" value={audio.voiceSettings.stability} onInput={(event) => setVoiceSetting("stability", numberValue(event.currentTarget.value))} />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-muted">Similarity · {audio.voiceSettings.similarityBoost.toFixed(2)}</span>
                  <input type="range" min="0" max="1" step="0.01" value={audio.voiceSettings.similarityBoost} onInput={(event) => setVoiceSetting("similarityBoost", numberValue(event.currentTarget.value))} />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-muted">Style · {audio.voiceSettings.style.toFixed(2)}</span>
                  <input type="range" min="0" max="1" step="0.01" value={audio.voiceSettings.style} onInput={(event) => setVoiceSetting("style", numberValue(event.currentTarget.value))} />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-muted">Speed · {audio.voiceSettings.speed.toFixed(2)}</span>
                  <input type="range" min="0.7" max="1.2" step="0.01" value={audio.voiceSettings.speed} onInput={(event) => setVoiceSetting("speed", numberValue(event.currentTarget.value))} />
                </label>
                <label class="flex items-center gap-2 text-12-regular text-text-base">
                  <input type="checkbox" checked={audio.voiceSettings.useSpeakerBoost} onChange={(event) => setVoiceSetting("useSpeakerBoost", event.currentTarget.checked)} />
                  Speaker boost
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-muted">Language code</span>
                  <input
                    class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                    placeholder="optional, e.g. en"
                    value={audio.languageCode ?? ""}
                    onInput={(event) => setAudio("languageCode", event.currentTarget.value.trim() || undefined)}
                  />
                </label>
              </div>
              <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3">
                <div class="text-12-medium uppercase tracking-wide text-text-muted">Text</div>
                <div class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-text-base">{input.text.slice(0, 500)}</div>
              </div>
              </div>
              <div class="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border-base px-1 pt-3">
                <Button variant="ghost" size="normal" onClick={() => done(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="normal" onClick={() => done({ ...audio, voiceSettings: { ...audio.voiceSettings } })}>
                  Generate audio
                </Button>
              </div>
              <div class="flex-shrink-0 px-1 text-12-regular text-text-muted">
                Leave Voice ID blank to auto-pick a generated voice from your ElevenLabs account. Use Connect provider or
                the parent `.env` for the API key.
              </div>
            </div>
          </Dialog>
        ),
        () => done(false),
      )
    })
  }

  const confirmModel3DGeneration = (input: {
    provider: string
    model: string
    text: string
    inputMode: "text" | "image"
    autoApprove: boolean
  }) => {
    if (input.autoApprove) return loadModel3DSettings()
    return new Promise<Model3DGenerationSettings | false>((resolve) => {
      const [model3d, setModel3d] = createStore(loadModel3DSettings())
      const versions = ["v3.1-20260211", "v3.0-20250812"]
      const formats = ["glb", "obj"]
      let settled = false
      const done = (value: Model3DGenerationSettings | false) => {
        if (settled) return
        settled = true
        if (value) saveModel3DSettings(value)
        dialog.close()
        resolve(value)
      }
      dialog.show(
        () => (
          <Dialog
            title="Generate 3D model?"
            description="Review the Tripo request before CodeGoblin spends credits."
            action={
              <Button variant="ghost" size="normal" onClick={() => done(false)}>
                Not now
              </Button>
            }
          >
            <div class="flex h-full flex-col gap-4 text-13-regular text-text-base">
              <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
                <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3 text-12-regular text-text-muted">
                  Tripo credits apply. Turn on Auto-approve 3D generation in Settings &gt; General to skip this dialog.
                </div>
                <div class="grid gap-3 rounded-lg border border-border-base bg-surface-raised px-4 py-3 sm:grid-cols-2">
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Model</span>
                    <span class="font-mono text-12-regular text-text-strong">{input.provider}/{input.model}</span>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Input mode</span>
                    <span class="text-12-regular text-text-strong">{input.inputMode}</span>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Tripo version</span>
                    <select
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                      value={model3d.modelVersion}
                      onChange={(event) => setModel3d("modelVersion", event.currentTarget.value)}
                    >
                      {versions.map((version) => (
                        <option value={version}>{version}</option>
                      ))}
                    </select>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-medium uppercase tracking-wide text-text-muted">Output format</span>
                    <select
                      class="rounded-md border border-border-base bg-surface-raised-stronger px-2 py-1 text-12-regular text-text-strong outline-none"
                      value={model3d.outputFormat}
                      onChange={(event) => setModel3d("outputFormat", event.currentTarget.value)}
                    >
                      {formats.map((format) => (
                        <option value={format}>{format.toUpperCase()}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div class="rounded-lg border border-border-base bg-surface-raised px-4 py-3">
                  <div class="text-12-medium uppercase tracking-wide text-text-muted">Prompt</div>
                  <div class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-text-base">
                    {input.text.slice(0, 500) || "Attached image input"}
                  </div>
                </div>
              </div>
              <div class="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border-base px-1 pt-3">
                <Button variant="ghost" size="normal" onClick={() => done(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="normal" onClick={() => done({ ...model3d })}>
                  Generate 3D model
                </Button>
              </div>
            </div>
          </Dialog>
        ),
        () => done(false),
      )
    })
  }

  const { abort, handleSubmit } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
    confirmImageGeneration,
    confirmAudioGeneration,
    confirmModel3DGeneration,
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleSubmit(event)
    }
  }

  const [agentsQuery, globalProvidersQuery, providersQuery] = useQueries(() => ({
    queries: [
      queryOptions.agents(pathKey(sdk.directory)),
      queryOptions.providers(null),
      queryOptions.providers(pathKey(sdk.directory)),
    ],
  }))

  const agentsLoading = () => agentsQuery.isLoading
  const agentsShouldFadeIn = createMemo((prev) => prev ?? agentsLoading())
  const providersLoading = () => agentsLoading() || providersQuery.isLoading || globalProvidersQuery.isLoading
  const providersShouldFadeIn = createMemo((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready().promise,
    (p) => p,
  )

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    return "Ask the goblin... / for commands, @ for context..."
  }

  const modelControl = () => (
    <Show when={!providersLoading()}>
      <Show
        when={providers.paid().length > 0}
        fallback={
          <TooltipKeybind
            placement="top"
            gutter={4}
            title={language.t("command.model.choose")}
            keybind={command.keybind("model.choose")}
          >
            <Button
              data-action="prompt-model"
              as="div"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint group"
              style={control()}
              onClick={() => {
                void import("@/components/dialog-select-model-unpaid").then((x) => {
                  dialog.show(() => <x.DialogSelectModelUnpaid model={local.model} />)
                })
              }}
            >
              <Show when={local.model.current()?.provider?.id}>
                <ProviderIcon
                  id={local.model.current()?.provider?.id ?? ""}
                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                />
              </Show>
              <span class="truncate">{local.model.current()?.name ?? language.t("dialog.model.select.title")}</span>
              <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={language.t("command.model.choose")}
          keybind={command.keybind("model.choose")}
        >
          <ModelSelectorPopover
            model={local.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: control(),
              class:
                "min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint group",
              "data-action": "prompt-model",
            }}
            onClose={restoreFocus}
          >
            <Show when={local.model.current()?.provider?.id}>
              <ProviderIcon
                id={local.model.current()?.provider?.id ?? ""}
                class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                style={{ "will-change": "opacity", transform: "translateZ(0)" }}
              />
            </Show>
            <span class="truncate">{local.model.current()?.name ?? language.t("dialog.model.select.title")}</span>
            <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          </ModelSelectorPopover>
        </TooltipKeybind>
      </Show>
    </Show>
  )

  const newSession = () => props.variant === "new-session"
  const worktrees = createMemo(() => [MAIN_WORKTREE, ...(sync.project?.sandboxes ?? []), CREATE_WORKTREE])
  const currentWorktree = createMemo(() => {
    if (worktrees().includes(props.newSessionWorktree ?? MAIN_WORKTREE))
      return props.newSessionWorktree ?? MAIN_WORKTREE
    return MAIN_WORKTREE
  })
  const worktreeLabel = (value: string) => {
    if (value === MAIN_WORKTREE) return MAIN_WORKTREE
    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")
    return getFilename(value)
  }

  const USE_V2_INPUT = true // redesign shipped in 0.2.x — no longer channel-gated

  return (
    <div class="relative size-full flex flex-col gap-0">
      {(promptReady(), null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Switch>
        <Match when={USE_V2_INPUT}>
          <DockShellForm
            data-component={newSession() ? "session-new-composer" : "session-composer"}
            onSubmit={handleSubmit}
            classList={{
              "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base border border-[#244a28] shadow-[var(--v2-elevation-raised)] transition-colors focus-within:border-[#3a7d3f]": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <PromptDragOverlay
              type={store.draggingType}
              label={language.t(
                store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
              )}
            />
            <PromptContextItems
              items={contextItems()}
              active={(item) => {
                const active = comments.active()
                return !!item.commentID && item.commentID === active?.id && item.path === active?.file
              }}
              openComment={openComment}
              remove={(item) => {
                if (item.commentID) comments.remove(item.path, item.commentID)
                prompt.context.remove(item.key)
              }}
              t={(key) => language.t(key as Parameters<typeof language.t>[0])}
            />
            <PromptImageAttachments
              attachments={imageAttachments()}
              onOpen={(attachment) =>
                dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
              }
              onRemove={removeAttachment}
              removeLabel={language.t("prompt.attachment.remove")}
            />
            <div
              class="relative min-h-[52px]"
              onMouseDown={(e) => {
                const target = e.target
                if (!(target instanceof HTMLElement)) return
                if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) return
                editorRef?.focus()
              }}
            >
              <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
                <div
                  data-component="prompt-input"
                  ref={(el) => {
                    editorRef = el
                    props.ref?.(el)
                  }}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={designPlaceholder()}
                  contenteditable="true"
                  autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                  autocorrect={store.mode === "normal" ? "on" : "off"}
                  spellcheck={store.mode === "normal"}
                  inputMode="text"
                  // @ts-expect-error
                  autocomplete="off"
                  onInput={handleInput}
                  onPaste={handlePaste}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  classList={{
                    "select-text": true,
                    "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]": true,
                    "[&_[data-type=file]]:text-syntax-property": true,
                    "[&_[data-type=command]]:text-syntax-keyword": true,
                    "[&_[data-type=command]]:font-medium": true,
                    "[&_[data-type=agent]]:text-syntax-type": true,
                    "font-mono!": store.mode === "shell",
                  }}
                />
                <div
                  data-component={newSession() ? "session-new-design-text" : "session-composer-text"}
                  class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]"
                  classList={{ "font-mono!": store.mode === "shell", hidden: prompt.dirty() }}
                >
                  {designPlaceholder()}
                </div>
              </div>
            </div>
            <div class="flex h-11 items-center px-2">
              <div class="flex min-w-0 flex-1 items-center gap-0">
                {fileAttachmentInput()}
                <DropdownMenu gutter={6} placement="top-start">
                  <DropdownMenu.Trigger
                    as={IconButton}
                    data-action="prompt-attach"
                    type="button"
                    icon="plus"
                    variant="ghost"
                    class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
                    style={buttons()}
                    disabled={store.mode !== "normal"}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    aria-label={language.t("prompt.action.attachFile")}
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="min-w-[200px]">
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>Bring into the cave</DropdownMenu.GroupLabel>
                        <DropdownMenu.Item onSelect={() => pick()}>
                          <Icon name="open-file" class="text-[#9ADB35]" />
                          <DropdownMenu.ItemLabel>{language.t("prompt.action.attachFile")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={platform.readClipboardImage}>
                          <DropdownMenu.Item onSelect={() => void attachFromClipboard()}>
                            <Icon name="cloud-upload" class="text-[#9ADB35]" />
                            <DropdownMenu.ItemLabel>Paste image</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Item onSelect={openMentionPicker}>
                          <Icon name="bubble-5" class="text-[#9ADB35]" />
                          <DropdownMenu.ItemLabel>Mention a file or agent</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={openCommandPalette}>
                          <Icon name="terminal" class="text-[#9ADB35]" />
                          <DropdownMenu.ItemLabel>Run a command</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <Show when={newSession()}>
                  <div class="relative">
                    <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
                      <Icon name="sliders" size="small" />
                    </div>
                    <Select
                      size="normal"
                      options={worktrees()}
                      current={currentWorktree()}
                      label={worktreeLabel}
                      onSelect={(value) => {
                        if (value) props.onNewSessionWorktreeChange?.(value)
                        restoreFocus()
                      }}
                      class="max-w-[175px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
                      valueClass="truncate pl-5 text-[13px] font-[440] leading-4 text-v2-text-text-faint"
                      triggerStyle={control()}
                      triggerProps={{ "data-action": "prompt-workspace" }}
                      variant="ghost"
                    />
                  </div>
                </Show>
                <div class="flex-1" />
                {modelControl()}
              </div>
              <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                <IconButton
                  data-action="prompt-submit"
                  type="submit"
                  disabled={!working() && blank()}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                  variant="primary"
                  class="size-7 rounded-full p-[6px] text-[#06210a] shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
                  style={{
                    "background-image":
                      "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(135deg,#9ADB35 0%,#6fae28 100%)",
                  }}
                  aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                />
              </Tooltip>
            </div>
          </DockShellForm>
        </Match>
        <Match when>
          <DockShellForm
            onSubmit={handleSubmit}
            classList={{
              "group/prompt-input": true,
              "focus-within:shadow-xs-border": true,
              "border-icon-info-active border-dashed": store.draggingType !== null,
              [props.class ?? ""]: !!props.class,
            }}
          >
            <PromptDragOverlay
              type={store.draggingType}
              label={language.t(
                store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
              )}
            />
            <PromptContextItems
              items={contextItems()}
              active={(item) => {
                const active = comments.active()
                return !!item.commentID && item.commentID === active?.id && item.path === active?.file
              }}
              openComment={openComment}
              remove={(item) => {
                if (item.commentID) comments.remove(item.path, item.commentID)
                prompt.context.remove(item.key)
              }}
              t={(key) => language.t(key as Parameters<typeof language.t>[0])}
            />
            <PromptImageAttachments
              attachments={imageAttachments()}
              onOpen={(attachment) =>
                dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
              }
              onRemove={removeAttachment}
              removeLabel={language.t("prompt.attachment.remove")}
            />
            <div
              class="relative"
              onMouseDown={(e) => {
                const target = e.target
                if (!(target instanceof HTMLElement)) return
                if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) {
                  return
                }
                editorRef?.focus()
              }}
            >
              <div
                class="relative max-h-[240px] overflow-y-auto no-scrollbar"
                ref={(el) => (scrollRef = el)}
                style={{ "scroll-padding-bottom": space }}
              >
                <div
                  data-component="prompt-input"
                  ref={(el) => {
                    editorRef = el
                    props.ref?.(el)
                  }}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={placeholder()}
                  contenteditable="true"
                  autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                  autocorrect={store.mode === "normal" ? "on" : "off"}
                  spellcheck={store.mode === "normal"}
                  inputMode="text"
                  // @ts-expect-error
                  autocomplete="off"
                  onInput={handleInput}
                  onPaste={handlePaste}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  classList={{
                    "select-text": true,
                    "w-full pl-3 pr-2 pt-2 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
                    "[&_[data-type=file]]:text-syntax-property": true,
                    "[&_[data-type=command]]:text-syntax-keyword": true,
                    "[&_[data-type=command]]:font-medium": true,
                    "[&_[data-type=agent]]:text-syntax-type": true,
                    "font-mono!": store.mode === "shell",
                  }}
                  style={{ "padding-bottom": space }}
                />
                <div
                  class="absolute top-0 inset-x-0 pl-3 pr-2 pt-2 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
                  classList={{ "font-mono!": store.mode === "shell" }}
                  style={{ "padding-bottom": space, display: prompt.dirty() ? "none" : undefined }}
                >
                  {placeholder()}
                </div>
              </div>

              <div
                aria-hidden="true"
                class="pointer-events-none absolute inset-x-0 bottom-0"
                style={{
                  height: space,
                  background:
                    "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
                }}
              />

              <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPTED_FILE_TYPES.join(",")}
                  class="hidden"
                  onChange={(e) => {
                    const list = e.currentTarget.files
                    if (list) void addAttachments(Array.from(list))
                    e.currentTarget.value = ""
                  }}
                />

                <div class="flex items-center gap-1 pointer-events-auto">
                  <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                    <IconButton
                      data-action="prompt-submit"
                      type="submit"
                      disabled={!working() && blank()}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                      variant="primary"
                      class="size-8"
                      aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                    />
                  </Tooltip>
                </div>
              </div>

              <div class="pointer-events-none absolute bottom-2 left-2">
                <div
                  aria-hidden={store.mode !== "normal"}
                  class="pointer-events-auto"
                  style={{
                    "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                  }}
                >
                  <TooltipKeybind
                    placement="top"
                    title={language.t("prompt.action.attachFile")}
                    keybind={command.keybind("file.attach")}
                  >
                    <Button
                      data-action="prompt-attach"
                      type="button"
                      variant="ghost"
                      class="size-8 p-0"
                      style={buttons()}
                      onClick={pick}
                      disabled={store.mode !== "normal"}
                      tabIndex={store.mode === "normal" ? undefined : -1}
                      aria-label={language.t("prompt.action.attachFile")}
                    >
                      <Icon name="plus" class="size-4.5" />
                    </Button>
                  </TooltipKeybind>
                </div>
              </div>
            </div>
          </DockShellForm>
          <Show when={store.mode === "normal" || store.mode === "shell"}>
            <DockTray attach="top">
              <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
                  <div
                    class="h-7 flex items-center gap-1.5 min-w-0 absolute inset-0"
                    style={{
                      padding: "0 0px 0 8px",
                      ...shell(),
                    }}
                  >
                    <Icon name="console" />
                    <span class="truncate text-13-medium text-text-base">{language.t("prompt.mode.shell")}</span>
                    <div class="flex-1" />
                    <Button
                      variant="ghost"
                      class="text-text-base"
                      onClick={() => {
                        setStore("mode", "normal")
                      }}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                  <div class="flex items-center justify-end gap-1.5 min-w-0 flex-1 h-7">
                    <Show when={!agentsLoading()}>
                      <div
                        data-component="prompt-agent-control"
                        style={agentsShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
                      >
                        <TooltipKeybind
                          placement="top"
                          gutter={4}
                          title={language.t("command.agent.cycle")}
                          keybind={command.keybind("agent.cycle")}
                        >
                          <Select
                            size="normal"
                            options={agentNames()}
                            current={local.agent.current()?.name ?? ""}
                            onSelect={(value) => {
                              local.agent.set(value)
                              restoreFocus()
                            }}
                            class="capitalize max-w-[160px] text-text-base"
                            valueClass="truncate text-13-regular text-text-base"
                            triggerStyle={control()}
                            triggerProps={{ "data-action": "prompt-agent" }}
                            variant="ghost"
                          />
                        </TooltipKeybind>
                      </div>
                    </Show>
                    <Show when={!providersLoading()}>
                      <Show when={store.mode !== "shell"}>
                        <div
                          data-component="prompt-model-control"
                          style={providersShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
                        >
                          <Show
                            when={providers.paid().length > 0}
                            fallback={
                              <TooltipKeybind
                                placement="top"
                                gutter={4}
                                title={language.t("command.model.choose")}
                                keybind={command.keybind("model.choose")}
                              >
                                <Button
                                  data-action="prompt-model"
                                  as="div"
                                  variant="ghost"
                                  size="normal"
                                  class="min-w-0 max-w-[320px] text-13-regular text-text-base group"
                                  style={control()}
                                  onClick={() => {
                                    void import("@/components/dialog-select-model-unpaid").then((x) => {
                                      dialog.show(() => <x.DialogSelectModelUnpaid model={local.model} />)
                                    })
                                  }}
                                >
                                  <Show when={local.model.current()?.provider?.id}>
                                    <ProviderIcon
                                      id={local.model.current()?.provider?.id ?? ""}
                                      class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                      style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                    />
                                  </Show>
                                  <span class="truncate">
                                    {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                                  </span>
                                  <Icon name="chevron-down" size="small" class="shrink-0" />
                                </Button>
                              </TooltipKeybind>
                            }
                          >
                            <TooltipKeybind
                              placement="top"
                              gutter={4}
                              title={language.t("command.model.choose")}
                              keybind={command.keybind("model.choose")}
                            >
                              <ModelSelectorPopover
                                model={local.model}
                                triggerAs={Button}
                                triggerProps={{
                                  variant: "ghost",
                                  size: "normal",
                                  style: control(),
                                  class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
                                  "data-action": "prompt-model",
                                }}
                                onClose={restoreFocus}
                              >
                                <Show when={local.model.current()?.provider?.id}>
                                  <ProviderIcon
                                    id={local.model.current()?.provider?.id ?? ""}
                                    class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                    style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                  />
                                </Show>
                                <span class="truncate">
                                  {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                                </span>
                                <Icon name="chevron-down" size="small" class="shrink-0" />
                              </ModelSelectorPopover>
                            </TooltipKeybind>
                          </Show>
                        </div>
                        <Show when={variants().length > 2}>
                          <div
                            data-component="prompt-variant-control"
                            style={providersShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
                          >
                            <TooltipKeybind
                              placement="top"
                              gutter={4}
                              title={language.t("command.model.variant.cycle")}
                              keybind={command.keybind("model.variant.cycle")}
                            >
                              <Select
                                size="normal"
                                options={variants()}
                                current={local.model.variant.current() ?? "default"}
                                label={(x) => (x === "default" ? language.t("common.default") : x)}
                                onSelect={(value) => {
                                  local.model.variant.set(value === "default" ? undefined : value)
                                  restoreFocus()
                                }}
                                class="capitalize max-w-[160px] text-text-base"
                                valueClass="truncate text-13-regular text-text-base"
                                triggerStyle={control()}
                                triggerProps={{ "data-action": "prompt-model-variant" }}
                                variant="ghost"
                              />
                            </TooltipKeybind>
                          </div>
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            </DockTray>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
