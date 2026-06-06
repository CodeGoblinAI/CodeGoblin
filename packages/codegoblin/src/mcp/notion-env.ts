/** Workaround for @notionhq/notion-mcp-server not always sending NOTION_TOKEN as Authorization (see makenotion/notion-mcp-server#95). */
export function notionOpenApiHeaders(token: string): string {
  return JSON.stringify({
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
  })
}

export function augmentNotionEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) next[key] = value
  }
  const token = next.NOTION_TOKEN?.trim()
  if (!token || /^\$\{[^}]+\}$/.test(token)) return next
  next.OPENAPI_MCP_HEADERS = notionOpenApiHeaders(token)
  return next
}
