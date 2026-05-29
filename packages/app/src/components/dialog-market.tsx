import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Component, createMemo, createResource, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useQueryOptions } from "@/context/global-sync"
import { pathKey } from "@/utils/path-key"
import { authTokenFromCredentials } from "@/utils/server"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"

type MarketEntry = {
  id: string
  name: string
  kind: string
  category: string
  description: string
  homepage?: string
  env?: { name: string; description: string }[]
  mcp?: unknown
}

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

  const action = useMutation(() => ({
    mutationFn: async (entry: MarketEntry) => {
      const status = sync.data.mcp?.[entry.id]?.status
      if (!status) {
        const response = await fetch(`${sdk.url}/codegoblin/market/install`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ id: entry.id }),
        })
        const body = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; name?: string; config?: any; message?: string }
          | undefined
        if (!response.ok || !body?.ok || !body.config) {
          throw new Error(body?.message ?? "Could not add to config.")
        }
        await sdk.client.mcp.add({ name: body.name ?? entry.id, config: body.config })
        showToast({ title: `${entry.name} added`, description: "Added to opencode.json and connecting." })
        return
      }
      if (status === "connected") {
        await sdk.client.mcp.disconnect({ name: entry.id })
        return
      }
      if (status === "needs_auth") {
        await sdk.client.mcp.auth.authenticate({ name: entry.id })
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
        onSelect={(x) => {
          if (!x || action.isPending) return
          action.mutate(x)
        }}
      >
        {(entry) => {
          const status = () => sync.data.mcp?.[entry.id]?.status
          const statusLabel = () => {
            const s = status()
            if (!s) return "Not added"
            return statusLabels[s] ?? s
          }
          const enabled = () => status() === "connected"
          return (
            <div class="w-full flex items-center justify-between gap-x-3">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="truncate">{entry.name}</span>
                  <span class="text-11-regular text-text-weaker">{statusLabel()}</span>
                </div>
                <span class="text-11-regular text-text-weaker truncate">{entry.description}</span>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={enabled()}
                  disabled={action.isPending && action.variables?.id === entry.id}
                  onChange={() => {
                    if (action.isPending) return
                    action.mutate(entry)
                  }}
                />
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
