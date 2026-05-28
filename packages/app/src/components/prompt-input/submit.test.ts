import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent?: string
    role?: string
    id?: string
    model?: { providerID: string; modelID: string; variant?: string }
    providerID?: string
    modelID?: string
    variant?: string
  }
  parts?: Array<Record<string, unknown>>
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let selectedModel = { id: "model", provider: { id: "provider" } }
let imageGenerationAutoApprove = false
let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
let promptResetCount = 0
let promptSetCount = 0
const fetchRequests: Array<{ url: string; body: any }> = []
const originalFetch = globalThis.fetch
const originalConfirm = globalThis.confirm
const confirmPrompts: string[] = []
let confirmResponse = true

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async () => ({ data: undefined }),
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => selectedModel,
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => {
        promptResetCount++
      },
      set: () => {
        promptSetCount++
      },
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({ current: undefined }),
  }))

  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      permissions: {
        imageGenerationAutoApprove: () => imageGenerationAutoApprove,
      },
    }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: {
              agent?: string
              role?: string
              id?: string
              model?: { providerID: string; modelID: string; variant?: string }
              providerID?: string
              modelID?: string
              variant?: string
            }
            parts?: Array<Record<string, unknown>>
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  globalThis.confirm = ((message?: string) => {
    confirmPrompts.push(String(message ?? ""))
    return confirmResponse
  }) as typeof globalThis.confirm
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchRequests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(
      JSON.stringify({
        ok: true,
        message: "Image generated with openai/gpt-image-1. Saved to C:\\repo\\main\\codegoblin-output\\images\\test.png.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  fetchRequests.length = 0
  confirmPrompts.length = 0
  confirmResponse = true
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  selectedModel = { id: "model", provider: { id: "provider" } }
  imageGenerationAutoApprove = false
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  promptResetCount = 0
  promptSetCount = 0
  variant = undefined
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

afterAll(() => {
  globalThis.fetch = originalFetch
  globalThis.confirm = originalConfirm
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("persists web image requests as chat messages with the selected image model", async () => {
    params = { id: "session-1" }
    selectedModel = { id: "gpt-image-1", provider: { id: "openai" } }
    promptValue = [
      {
        type: "text",
        content: "generate an image of a horse",
        start: 0,
        end: "generate an image of a horse".length,
      },
    ]

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [
        {
          type: "image",
          id: "image-1",
          dataUrl: "data:image/png;base64,abc123",
          mime: "image/png",
          filename: "input.png",
        },
      ],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)

    expect(confirmPrompts).toHaveLength(1)
    expect(confirmPrompts[0]).toContain("Generate an image with openai/gpt-image-1")
    expect(promptResetCount).toBe(1)
    expect(optimistic).toHaveLength(2)
    expect(optimistic[0]).toMatchObject({
      directory: "/repo/main",
      sessionID: "session-1",
      message: {
        role: "user",
        model: { providerID: "openai", modelID: "gpt-image-1" },
      },
    })
    expect(optimistic[0]?.parts?.[0]).toMatchObject({
      type: "text",
      text: "generate an image of a horse",
    })
    expect(optimistic[0]?.parts?.[1]).toMatchObject({
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,abc123",
      filename: "input.png",
    })
    expect(optimistic[1]).toMatchObject({
      directory: "/repo/main",
      sessionID: "session-1",
      message: {
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-image-1",
      },
    })
    expect(String(optimistic[1]?.parts?.[0]?.text)).toContain("CodeGoblin is generating an image with openai/gpt-image-1")
    expect(String(optimistic[1]?.parts?.[0]?.text)).toContain("/repo/main/codegoblin-output/images/")
    expect((optimistic[1]?.parts?.[0] as any)?.metadata).toMatchObject({
      codegoblin: {
        kind: "image-progress",
        provider: "openai",
        model: "gpt-image-1",
      },
    })
    expect(String((optimistic[1]?.parts?.[0] as any)?.metadata?.codegoblin?.output)).toContain(
      "/repo/main/codegoblin-output/images/",
    )
    expect(fetchRequests).toHaveLength(1)
    expect(fetchRequests[0]).toMatchObject({
      url: "http://localhost:4096/codegoblin/image",
      body: {
        sessionID: "session-1",
        prompt: "generate an image of a horse",
        output: expect.stringMatching(/^codegoblin-output\/images\/.+\.png$/),
        provider: "openai",
        model: "gpt-image-1",
        inputImages: [
          {
            dataUrl: "data:image/png;base64,abc123",
            mime: "image/png",
            filename: "input.png",
          },
        ],
        requireImageModel: true,
      },
    })
    expect(fetchRequests[0]?.body.messageID).toBe(optimistic[0]?.message.id)
    expect(fetchRequests[0]?.body.assistantMessageID).toBe(optimistic[1]?.message.id)
  })

  test("does not send implicit web image requests when confirmation is rejected", async () => {
    params = { id: "session-1" }
    selectedModel = { id: "gpt-image-1", provider: { id: "openai" } }
    promptValue = [
      {
        type: "text",
        content: "generate an image of a horse",
        start: 0,
        end: "generate an image of a horse".length,
      },
    ]
    confirmResponse = false

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)

    expect(confirmPrompts).toHaveLength(1)
    expect(fetchRequests).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
    expect(promptResetCount).toBe(0)
  })

  test("uses settings to auto-approve implicit web image requests", async () => {
    params = { id: "session-1" }
    selectedModel = { id: "gpt-image-1", provider: { id: "openai" } }
    promptValue = [
      {
        type: "text",
        content: "generate an image of a horse",
        start: 0,
        end: "generate an image of a horse".length,
      },
    ]
    imageGenerationAutoApprove = true

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)

    expect(confirmPrompts).toHaveLength(0)
    expect(fetchRequests).toHaveLength(1)
    expect(promptResetCount).toBe(1)
  })

  test("routes descriptive prompts through the selected image model", async () => {
    params = { id: "session-1" }
    selectedModel = { id: "grok-imagine-image-quality", provider: { id: "xai" } }
    promptValue = [{ type: "text", content: "car with flames", start: 0, end: "car with flames".length }]

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)

    expect(confirmPrompts).toHaveLength(1)
    expect(confirmPrompts[0]).toContain("Generate an image with xai/grok-imagine-image-quality")
    expect(fetchRequests).toHaveLength(1)
    expect(fetchRequests[0]).toMatchObject({
      url: "http://localhost:4096/codegoblin/image",
      body: {
        prompt: "car with flames",
        provider: "xai",
        model: "grok-imagine-image-quality",
        requireImageModel: true,
      },
    })
    expect(promptResetCount).toBe(1)
  })

  test("does not send casual text to a selected image model", async () => {
    params = { id: "session-1" }
    selectedModel = { id: "gpt-image-1", provider: { id: "openai" } }
    promptValue = [{ type: "text", content: "hi", start: 0, end: 2 }]

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)

    expect(fetchRequests).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
    expect(promptResetCount).toBe(0)
    expect(promptSetCount).toBe(0)
  })
})
