import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Component, createMemo, createResource, For } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useQueryOptions } from "@/context/global-sync"
import { pathKey } from "@/utils/path-key"
import { authTokenFromCredentials } from "@/utils/server"
import { Button } from "@codegoblin/ui/button"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { showToast } from "@codegoblin/ui/toast"

type MarketEntry = {
  id: string
  name: string
  kind: string
  category: string
  description: string
  homepage?: string
  env?: { name: string; description: string }[]
  mcp?: { type?: string } | unknown
}

type MarketAction = "add" | "connect" | "disconnect" | "authenticate" | "firebase-login"

const statusLabels: Record<string, string> = {
  connected: "Connected",
  failed: "Failed",
  needs_auth: "Needs authentication",
  needs_client_registration: "Needs client ID",
  disabled: "Disabled",
}

export const DialogMarket: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const server = useServer()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  const headers = () => {
    const activeServer = server.current
    const result: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": sdk.directory,
    }
    if (activeServer?.http.password) {
      result.authorization = `Basic ${authTokenFromCredentials({
        username: activeServer.http.username,
        password: activeServer.http.password,
      })}`
    }
    return result
  }

  const [catalog] = createResource(async () => {
    const response = await fetch(`${sdk.url}/codegoblin/market?kind=mcp`, { headers: headers() })
    const body = (await response.json().catch(() => undefined)) as { ok?: boolean; entries?: MarketEntry[] } | undefined
    if (!response.ok || !body?.ok) {
      showToast({ variant: "error", icon: "circle-x", title: "Failed to load market" })
      return [] as MarketEntry[]
    }
    return (body.entries ?? []).sort((a, b) => a.name.localeCompare(b.name))
  })

  const refresh = () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory)))

  const mcpStatusFromAdd = (result: { data?: Record<string, { status?: string; error?: string }> }, name: string) => {
    const status = result.data?.[name]
    if (!status) throw new Error("Server did not return MCP status.")
    if (status.status === "failed") throw new Error(status.error ?? "Could not connect this MCP server.")
    return status
  }

  const action = useMutation(() => ({
    mutationFn: async (input: { entry: MarketEntry; action: MarketAction }) => {
      const { entry } = input
      if (input.action === "add") {
        const response = await fetch(`${sdk.url}/codegoblin/market/install`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ id: entry.id }),
        })
        const body = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; name?: string; config?: any; message?: string }
          | undefined
        if (!response.ok || !body?.ok || !body.config) {
          throw new Error(body?.message ?? "Could not add this server.")
        }
        const name = body.name ?? entry.id
        const addResult = await sdk.client.mcp.add({ name, config: body.config })
        if ("error" in addResult && addResult.error) {
          throw new Error("Could not connect this MCP server.")
        }
        const status = mcpStatusFromAdd(addResult, name)
        if (status.status === "needs_auth" || status.status === "needs_client_registration") {
          await sdk.client.mcp.auth.authenticate({ name })
          showToast({
            title: `Authenticating ${entry.name}`,
            description: "Complete sign-in in your browser.",
          })
          return
        }
        if (entry.id === "firebase") {
          const login = await fetch(`${sdk.url}/codegoblin/market/firebase-login`, {
            method: "POST",
            headers: headers(),
          })
          const loginBody = (await login.json().catch(() => undefined)) as { ok?: boolean; message?: string } | undefined
          if (!login.ok || !loginBody?.ok) {
            throw new Error(loginBody?.message ?? "Could not open Firebase sign-in.")
          }
          showToast({
            title: "Firebase sign-in",
            description: "Complete login in the terminal window that just opened.",
          })
          return
        }
        showToast({ title: `${entry.name} added`, description: "Connected." })
        return
      }
      if (input.action === "firebase-login") {
        const response = await fetch(`${sdk.url}/codegoblin/market/firebase-login`, {
          method: "POST",
          headers: headers(),
        })
        const body = (await response.json().catch(() => undefined)) as { ok?: boolean; message?: string } | undefined
        if (!response.ok || !body?.ok) {
          throw new Error(body?.message ?? "Could not open Firebase sign-in.")
        }
        showToast({
          title: "Firebase sign-in",
          description: "Complete login in the terminal window that just opened.",
        })
        return
      }
      if (input.action === "disconnect") {
        await sdk.client.mcp.disconnect({ name: entry.id })
        return
      }
      if (input.action === "authenticate") {
        await sdk.client.mcp.auth.authenticate({ name: entry.id })
        showToast({ title: `Authenticating ${entry.name}`, description: "Complete sign-in in your browser." })
        return
      }
      await sdk.client.mcp.connect({ name: entry.id })
    },
    onSuccess: () => refresh(),
    onError: (error) =>
      showToast({ variant: "error", icon: "circle-x", title: error instanceof Error ? error.message : "Action failed" }),
  }))

  const items = createMemo(() => catalog() ?? [])

  return (
    <Dialog title="Market" description="Add, connect, authenticate, or disconnect MCP servers.">
      <List
        search={{ placeholder: "Search market…", autofocus: true }}
        emptyMessage="No market entries."
        key={(x) => x?.id ?? ""}
        items={items}
        filterKeys={["name", "category", "description"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onSelect={() => {}}
      >
        {(entry) => {
          const status = () => sync.data.mcp?.[entry.id]?.status
          const statusLabel = () => {
            const s = status()
            if (!s) return "Not added"
            return statusLabels[s] ?? s
          }
          const isRemote = () => (entry.mcp as { type?: string } | undefined)?.type === "remote"
          const pending = () => action.isPending && action.variables?.entry.id === entry.id
          const actions = (): { action: MarketAction; label: string; variant?: "primary" | "ghost" }[] => {
            const s = status()
            if (!s) return [{ action: "add", label: "Add", variant: "primary" }]
            if (s === "needs_auth" || s === "needs_client_registration")
              return [
                { action: "authenticate", label: "Authenticate", variant: "primary" },
                { action: "disconnect", label: "Remove", variant: "ghost" },
              ]
            if (s === "connected")
              return isRemote()
                ? [
                    { action: "authenticate", label: "Re-authenticate", variant: "ghost" },
                    { action: "disconnect", label: "Disconnect", variant: "ghost" },
                  ]
                : entry.id === "firebase"
                  ? [
                      { action: "firebase-login", label: "Sign in", variant: "ghost" },
                      { action: "disconnect", label: "Disconnect", variant: "ghost" },
                    ]
                  : [{ action: "disconnect", label: "Disconnect", variant: "ghost" }]
            // failed / disabled / other
            return isRemote()
              ? [
                  { action: "connect", label: "Connect", variant: "primary" },
                  { action: "authenticate", label: "Authenticate", variant: "ghost" },
                ]
              : entry.id === "firebase"
                ? [
                    { action: "connect", label: "Connect", variant: "primary" },
                    { action: "firebase-login", label: "Sign in", variant: "ghost" },
                  ]
                : [{ action: "connect", label: "Connect", variant: "primary" }]
          }
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{entry.name}</span>
                  <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                </div>
                <span class="text-11-regular text-text-weaker truncate">{entry.description}</span>
              </div>
              <div class="flex items-center gap-x-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                <For each={actions()}>
                  {(item) => (
                    <Button
                      size="small"
                      variant={item.variant ?? "ghost"}
                      disabled={pending()}
                      onClick={() => {
                        if (action.isPending) return
                        action.mutate({ entry, action: item.action })
                      }}
                    >
                      {item.label}
                    </Button>
                  )}
                </For>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
