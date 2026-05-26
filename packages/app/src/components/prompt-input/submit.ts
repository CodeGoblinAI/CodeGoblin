import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { authTokenFromCredentials } from "@/utils/server"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const imageIntent = (text: string) =>
  /\b(create|generate|make|draw|render|design|edit|change|transform|paint)\b.{0,100}\b(image|picture|photo|logo|mascot|illustration|avatar|icon|cat|dog|horse|goblin|red|style)\b/i.test(
    text,
  )

const imageModelSelected = (model: { id: string; provider: { id: string }; capabilities?: any }) => {
  if (model.capabilities?.output?.image) return true
  const raw = `${model.provider.id}/${model.id}`.toLowerCase()
  return (
    raw.includes("flash-image") ||
    raw.includes("imagen") ||
    raw.includes("nano-banana") ||
    raw.includes("nanobanana") ||
    raw.includes("grok-imagine-image") ||
    raw.includes("gpt-image") ||
    raw.includes("dall-e") ||
    raw.includes("qwen-image") ||
    raw.includes("wan2.")
  )
}

const legacyImageAutoApprove = () => {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem("codegoblin.image.autoApprove") === "true"
  } catch {
    return false
  }
}

const confirmImageGeneration = (provider: string, model: string, text: string, autoApprove: boolean) => {
  if (autoApprove || legacyImageAutoApprove()) return true
  if (typeof globalThis.confirm !== "function") return false
  return globalThis.confirm(
    [
      `Generate an image with ${provider}/${model}?`,
      "",
      text.slice(0, 240),
      "",
      "Use /image for explicit image jobs, or turn on Auto-approve image generation in Settings > General.",
    ].join("\n"),
  )
}

const defaultImageOutput = () => `codegoblin-output/images/${new Date().toISOString().replace(/[:.]/g, "-")}.png`

const slashImageOutput = (input: string) => {
  const match = /(?:^|\s)--output(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(input)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const displayImageOutput = (directory: string, output: string | undefined) => {
  if (!output) return
  if (/^[A-Za-z]:[\\/]/.test(output) || output.startsWith("\\\\") || output.startsWith("/")) return output
  const root = directory.replace(/[\\/]+$/, "")
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes("\\")) return `${root}\\${output.replace(/\//g, "\\")}`
  return `${root}/${output.replace(/\\/g, "/")}`
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      messageID,
      parts: requestParts,
      variant: input.draft.variant,
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const server = useServer()
  const settings = useSettings()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    globalSync.todo.set(sessionID, [])
    const [, setStore] = globalSync.child(sdk.directory)
    setStore("todo", sessionID, [])

    input.onAbort?.()

    const queued = pending.get(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(sessionID)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    if (mode === "normal") {
      const trimmed = text.trimStart()
      const isImageSlash = trimmed.startsWith("/image")
      const selectedImageModel = imageModelSelected(currentModel)
      const looksLikeImageRequest = imageIntent(trimmed)
      if (!isImageSlash && looksLikeImageRequest && !selectedImageModel) {
        showToast({
          title: "Select an image model",
          description:
            "That looks like an image request. Pick an image model in /models first; CodeGoblin did not send it to the text model.",
        })
        return
      }
      if (!isImageSlash && selectedImageModel && !looksLikeImageRequest) {
        showToast({
          title: "Confirm image generation",
          description:
            "An image model is selected, but this does not look like an image request. Use /image or include generate/draw/edit so CodeGoblin does not spend image credits by accident.",
        })
        return
      }
      if (
        !isImageSlash &&
        selectedImageModel &&
        looksLikeImageRequest &&
        !confirmImageGeneration(
          currentModel.provider.id,
          currentModel.id,
          trimmed,
          settings.permissions.imageGenerationAutoApprove(),
        )
      ) {
        showToast({
          title: "Image generation not sent",
          description: "CodeGoblin did not spend image credits. Use /image to generate without this confirmation.",
        })
        return
      }
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = prompt.context.items().slice()
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext()
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "normal") {
      const trimmed = text.trimStart()
      const isImageSlash = trimmed.startsWith("/image")
      const selectedImageModel = imageModelSelected(currentModel)
      const looksLikeImageRequest = imageIntent(trimmed)
      if (isImageSlash || (selectedImageModel && looksLikeImageRequest)) {
        const activeServer = server.current
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-opencode-directory": sessionDirectory,
        }
        if (activeServer?.http.password) {
          headers.authorization = `Basic ${authTokenFromCredentials({
            username: activeServer.http.username,
            password: activeServer.http.password,
          })}`
        }

        const userMessageID = Identifier.ascending("message")
        const userPartID = Identifier.ascending("part")
        const assistantMessageID = Identifier.ascending("message")
        const assistantPartID = Identifier.ascending("part")
        const now = Date.now()
        const requestText = isImageSlash ? trimmed : text.trim()
        const plannedOutput = isImageSlash ? slashImageOutput(requestText) : defaultImageOutput()
        const plannedOutputDisplay = displayImageOutput(sessionDirectory, plannedOutput)
        const optimisticUser: Message = {
          id: userMessageID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent,
          model: { ...model, variant },
        }
        const optimisticUserParts: Part[] = [
          {
            id: userPartID,
            sessionID: session.id,
            messageID: userMessageID,
            type: "text",
            text: requestText,
          } as Part,
          ...images.map(
            (attachment) =>
              ({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: userMessageID,
                type: "file",
                mime: attachment.mime,
                url: attachment.dataUrl,
                filename: attachment.filename,
              }) as Part,
          ),
        ]
        const optimisticAssistant: Message = {
          id: assistantMessageID,
          parentID: userMessageID,
          sessionID: session.id,
          role: "assistant",
          mode: agent,
          agent,
          variant,
          providerID: currentModel.provider.id,
          modelID: currentModel.id,
          path: { cwd: sessionDirectory, root: sessionDirectory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1 },
        } as Message
        const optimisticAssistantParts: Part[] = [
          {
            id: assistantPartID,
            sessionID: session.id,
            messageID: assistantMessageID,
            type: "text",
            text: [
              `CodeGoblin is generating an image with ${currentModel.provider.id}/${currentModel.id}.`,
              plannedOutputDisplay ? `Saving to: ${plannedOutputDisplay}` : "The final output path will stay in this chat.",
            ].join("\n"),
            metadata: {
              codegoblin: {
                kind: "image-progress",
                provider: currentModel.provider.id,
                model: currentModel.id,
                output: plannedOutputDisplay,
              },
            },
          } as Part,
        ]
        batch(() => {
          const [, setDirectoryStore] = globalSync.child(sessionDirectory)
          setDirectoryStore("session_status", session.id, { type: "busy" })
          sync.session.optimistic.add({
            directory: sessionDirectory,
            sessionID: session.id,
            message: optimisticUser,
            parts: optimisticUserParts,
          })
          sync.session.optimistic.add({
            directory: sessionDirectory,
            sessionID: session.id,
            message: optimisticAssistant,
            parts: optimisticAssistantParts,
          })
        })
        clearInput()
        clearContext()
        showToast({
          title: "Image generation started",
          description: `CodeGoblin is using ${currentModel.provider.id}/${currentModel.id}. The output path will stay in this chat.`,
        })

        setTimeout(() => {
          void sync.session.sync?.(session.id, { force: true })
        }, 500)

        fetch(`${sdk.url}/codegoblin/image`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sessionID: session.id,
            messageID: userMessageID,
            userPartID,
            assistantMessageID,
            assistantPartID,
            agent,
            variant,
            input: isImageSlash ? trimmed : undefined,
            prompt: isImageSlash ? undefined : trimmed,
            output: plannedOutput,
            provider: currentModel.provider.id,
            model: currentModel.id,
            inputImages: images.map((attachment) => ({
              dataUrl: attachment.dataUrl,
              mime: attachment.mime,
              filename: attachment.filename,
            })),
            requireImageModel: true,
          }),
        })
          .then(async (response) => {
            const result = (await response.json().catch(() => undefined)) as
              | { ok?: boolean; message?: string; requiresImageModel?: boolean }
              | undefined
            void sync.session.sync?.(session.id, { force: true })
            if (!response.ok || !result?.ok) {
              showToast({
                title: result?.requiresImageModel ? "Select an image model" : "Image generation failed",
                description: "The details were written to the chat.",
              })
              return
            }
            showToast({
              title: "Image generated",
              description: "The saved file path was written to the chat.",
            })
          })
          .catch((err) => {
            const [, setDirectoryStore] = globalSync.child(sessionDirectory)
            setDirectoryStore("session_status", session.id, { type: "idle" })
            void sync.session.sync?.(session.id, { force: true })
            showToast({
              title: "Image generation failed",
              description: errorMessage(err),
            })
          })
        return
      }
    }

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    removeCommentItems(commentItems)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync,
      globalSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      restoreCommentItems(commentItems)
      restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
