import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@codegoblin/core/util/encode"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/CodeGoblin/ImageSmoke"
const sessionID = "ses_codegoblin_image_smoke"
const projectID = "proj_codegoblin_image_smoke"
const textModel = { providerID: "google", modelID: "gemini-2.5-pro" }
const imageModel = { providerID: "google", modelID: "gemini-2.5-flash-image-preview" }
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9R9QAAAABJRU5ErkJggg==",
  "base64",
)

type CodeGoblinMetadata = { codegoblin?: { output?: string } }
type MessageInfo = Record<string, unknown> & { id: string; role: "user" | "assistant" }
type MessagePart = Record<string, unknown> & {
  id: string
  type: string
  text?: string
  mime?: string
  url?: string
  metadata?: CodeGoblinMetadata
}
type Message = { info: MessageInfo; parts: MessagePart[] }
type ImageRequest = Record<string, unknown> & {
  sessionID?: string
  provider?: string
  model?: string
  prompt?: string
  input?: string
  sourceAssistantMessageID?: string
  useLastImage?: boolean
  messageID?: string
  assistantMessageID?: string
  userPartID?: string
  assistantPartID?: string
}

test.describe("smoke: CodeGoblin image chat and market", () => {
  test.setTimeout(180_000)

  test("switches to image model, generates, edits, re-rolls, variants, and authenticates market MCP", async ({ page }) => {
    const errors = trackPageErrors(page)
    const fixture = createFixture()

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages: fixture.pageMessages,
      handleRoute: fixture.handleRoute,
    })
    await configureSmokePage(page)

    await selectHomeProject(page, fixture.project.name)
    await page.getByRole("button", { name: "Market" }).click()
    await expect(page.getByText("Needs authentication")).toBeVisible()
    await page.getByRole("button", { name: "Authenticate", exact: true }).click()
    await expect.poll(() => fixture.mcpAuthRequests.length).toBe(1)
    expect(fixture.mcpAuthRequests[0]).toContain("/mcp/github/auth/authenticate")
    await page.keyboard.press("Escape")

    await navigateToSession(page)
    await switchToImageModel(page)

    await submitPrompt(page, "draw a tiny goblin holding a lantern")
    await expect.poll(() => fixture.imageRequests.length).toBe(1)
    expect(fixture.imageRequests[0]).toMatchObject({
      sessionID,
      provider: imageModel.providerID,
      model: imageModel.modelID,
      prompt: "draw a tiny goblin holding a lantern",
    })
    await expect(page.getByText("Image generated").first()).toBeVisible()

    await submitPrompt(page, "make him red")
    await expect.poll(() => fixture.imageRequests.length).toBe(2)
    expect(fixture.imageRequests[1]).toMatchObject({
      sessionID,
      provider: imageModel.providerID,
      model: imageModel.modelID,
      prompt: "make him red",
      useLastImage: true,
    })

    const rerollSourceID = fixture.lastAssistantID()
    await page.getByRole("button", { name: "Re-roll image" }).last().click()
    await expect.poll(() => fixture.imageRequests.length).toBe(3)
    expect(fixture.imageRequests[2].sourceAssistantMessageID).toBe(rerollSourceID)

    const variantSourceID = fixture.imageRequests[2].sourceAssistantMessageID
    await page.getByRole("button", { name: "Create 3 image variations" }).last().click()
    await expect.poll(() => fixture.imageRequests.length).toBe(6)
    expect(fixture.imageRequests.slice(3).map((request) => request.sourceAssistantMessageID)).toEqual([
      variantSourceID,
      variantSourceID,
      variantSourceID,
    ])

    expectNoSmokeErrors(errors, [], [])
  })
})

function createFixture() {
  const messages: Message[] = []
  const imageRequests: ImageRequest[] = []
  const mcpAuthRequests: string[] = []
  let turn = 0

  const sessions = [
    {
      id: sessionID,
      slug: "image-smoke",
      projectID,
      directory,
      title: "CodeGoblin image smoke",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
  ]

  const provider = {
    all: [
      {
        id: "google",
        name: "Google",
        models: {
          [textModel.modelID]: {
            id: textModel.modelID,
            name: "Gemini 2.5 Pro",
            family: "gemini",
            capabilities: { input: { text: true }, output: { text: true } },
            limit: { context: 1_000_000 },
          },
          [imageModel.modelID]: {
            id: imageModel.modelID,
            name: "Nano Banana",
            family: "nano-banana",
            capabilities: { input: { text: true, image: true }, output: { image: true } },
            limit: { context: 32_000 },
          },
        },
      },
    ],
    connected: ["google"],
    default: { google: textModel.modelID },
  }

  const project = {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "codegoblin-image-smoke",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }

  const pageMessages = (id: string, limit: number, before?: string) => {
    if (id !== sessionID) return { items: [] }
    const end = before
      ? Math.max(
          0,
          messages.findIndex((message) => message.info.id === before),
        )
      : messages.length
    const start = Math.max(0, end - limit)
    return {
      items: messages.slice(start, end),
      cursor: start > 0 ? messages[start]?.info.id : undefined,
    }
  }

  const lastAssistantID = () => messages.findLast((message) => message.info.role === "assistant")?.info.id

  const handleRoute = async (route: Route, _url: URL, path: string) => {
    if (path === "/codegoblin/market") {
      await json(route, {
        ok: true,
        entries: [
          {
            id: "github",
            name: "GitHub MCP",
            kind: "mcp",
            category: "devtools",
            description: "OAuth-backed repository tools",
            mcp: { type: "remote", url: "https://mcp.github.test" },
          },
        ],
      })
      return true
    }
    if (path === "/mcp") {
      await json(route, { github: { status: "needs_auth" } })
      return true
    }
    if (path === "/mcp/github/auth/authenticate") {
      mcpAuthRequests.push(path)
      await json(route, { status: "connected" })
      return true
    }
    if (path === "/codegoblin/output-image") {
      await route.fulfill({ status: 200, contentType: "image/png", body: png })
      return true
    }
    if (path !== "/codegoblin/image") return false

    const body = (() => {
      try {
        return route.request().postDataJSON() as ImageRequest
      } catch {
        return {}
      }
    })()
    imageRequests.push(body)
    appendImageTurn(body)
    await json(route, {
      ok: true,
      output: messages.at(-1)?.parts.find((part) => part.type === "text")?.metadata?.codegoblin?.output,
      provider: body.provider ?? imageModel.providerID,
      model: body.model ?? imageModel.modelID,
    })
    return true
  }

  const appendImageTurn = (body: ImageRequest) => {
    turn++
    const source = body.sourceAssistantMessageID
      ? messages.find((message) => message.info.id === body.sourceAssistantMessageID)
      : undefined
    const sourceParentID = typeof source?.info.parentID === "string" ? source.info.parentID : undefined
    const sourceParent = sourceParentID ? messages.find((message) => message.info.id === sourceParentID) : undefined
    const prompt = String(
      body.prompt ??
        body.input ??
        sourceParent?.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ??
        "image replay",
    )
    const userID = body.messageID ?? `msg_user_image_${turn}`
    const assistantID = body.assistantMessageID ?? `msg_assistant_image_${turn}`
    const output = `codegoblin-output/images/smoke-${turn}.png`
    messages.push(
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created: 1700000000000 + turn * 10_000 },
          agent: "build",
          model: { providerID: body.provider ?? imageModel.providerID, modelID: body.model ?? imageModel.modelID },
        },
        parts: [
          {
            id: body.userPartID ?? `part_user_image_${turn}`,
            sessionID,
            messageID: userID,
            type: "text",
            text: prompt,
            metadata: { codegoblin: { kind: "image-request" } },
          },
        ],
      },
      {
        info: {
          id: assistantID,
          parentID: userID,
          sessionID,
          role: "assistant",
          mode: "build",
          agent: "build",
          providerID: body.provider ?? imageModel.providerID,
          modelID: body.model ?? imageModel.modelID,
          path: { cwd: directory, root: directory },
          cost: 0.01,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1700000000000 + turn * 10_000 + 1_000, completed: 1700000000000 + turn * 10_000 + 2_000 },
        },
        parts: [
          {
            id: body.assistantPartID ?? `part_assistant_image_${turn}`,
            sessionID,
            messageID: assistantID,
            type: "text",
            text: [`Image generated.`, `Model: ${body.provider ?? imageModel.providerID}/${body.model ?? imageModel.modelID}`, `Saved to: ${output}`].join("\n"),
            metadata: {
              codegoblin: {
                kind: "image-result",
                output,
                provider: body.provider ?? imageModel.providerID,
                model: body.model ?? imageModel.modelID,
              },
            },
          },
          {
            id: `part_assistant_file_${turn}`,
            sessionID,
            messageID: assistantID,
            type: "file",
            mime: "image/png",
            filename: `smoke-${turn}.png`,
            url: `data:image/png;base64,${png.toString("base64")}`,
            metadata: { codegoblin: { kind: "image-output", output } },
          },
        ],
      },
    )
  }

  return { sessions, provider, project, pageMessages, handleRoute, imageRequests, mcpAuthRequests, lastAssistantID }
}

async function configureSmokePage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
          showSessionProgressBar: true,
        },
      }),
    )
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)
}

async function selectHomeProject(page: Page, projectName: string) {
  await page.goto("/")
  await page
    .locator('[data-component="home-project-row"]')
    .filter({ hasText: new RegExp(projectName, "i") })
    .click()
  await expect(page).toHaveURL(/\/$/)
}

async function navigateToSession(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.getByRole("heading", { name: "CodeGoblin image smoke" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible()
}

async function switchToImageModel(page: Page) {
  await page.locator('[data-action="prompt-model"]').click()
  await page.getByText("Nano Banana").click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Nano Banana")
}

async function submitPrompt(page: Page, text: string) {
  const prompt = page.getByRole("textbox", { name: /Ask anything/i })
  await prompt.click()
  await prompt.fill(text)
  await page.getByRole("button", { name: /send/i }).click()
  const confirm = page.getByRole("button", { name: "Generate image" })
  if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) await confirm.click()
}

function json(route: Route, body: unknown, headers?: Record<string, string>) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}
