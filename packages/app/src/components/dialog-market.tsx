import { useMutation, useQueryClient } from "@tanstack/solid-query"

import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"

import { useSync } from "@/context/sync"

import { useSDK } from "@/context/sdk"

import { useServer } from "@/context/server"

import { useQueryOptions } from "@/context/global-sync"

import { pathKey } from "@/utils/path-key"

import { authTokenFromCredentials } from "@/utils/server"

import { MarketConfigureForm } from "@/components/dialog-market-configure"

import { Button } from "@codegoblin/ui/button"

import { Dialog } from "@codegoblin/ui/dialog"

import { List } from "@codegoblin/ui/list"

import { showToast } from "@codegoblin/ui/toast"

import type { McpStatus } from "@codegoblin/sdk/v2/client"



type MarketEntry = {

  id: string

  name: string

  kind: string

  category: string

  description: string

  homepage?: string

  needsEnv?: boolean

  installed?: boolean

  env?: { name: string; label?: string; description: string; link?: string }[]

  mcp?: { type?: string } | unknown

}



type MarketAction = "add" | "connect" | "remove" | "authenticate" | "firebase-login" | "configure"

type ConfigureMode = "install" | "reconfigure"



const statusLabels: Record<string, string> = {

  connecting: "Connecting…",

  connected: "Connected",

  failed: "Failed",

  disabled: "Disconnected",

  needs_auth: "Needs authentication",

  needs_client_registration: "Needs client ID",

}



export const DialogMarket: Component = () => {

  const sync = useSync()

  const sdk = useSDK()

  const server = useServer()

  const queryClient = useQueryClient()

  const queryOptions = useQueryOptions()

  const [configuring, setConfiguring] = createSignal<MarketEntry | undefined>()

  const [configureMode, setConfigureMode] = createSignal<ConfigureMode>("install")



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



  const [catalog, { refetch: refetchCatalog }] = createResource(async () => {

    const response = await fetch(`${sdk.url}/codegoblin/market?kind=mcp`, { headers: headers() })

    const body = (await response.json().catch(() => undefined)) as { ok?: boolean; entries?: MarketEntry[] } | undefined

    if (!response.ok || !body?.ok) {

      showToast({ variant: "error", icon: "circle-x", title: "Failed to load market" })

      return [] as MarketEntry[]

    }

    return (body.entries ?? []).sort((a, b) => a.name.localeCompare(b.name))

  })



  const refresh = () => queryClient.refetchQueries(queryOptions.mcp(pathKey(sdk.directory)))



  const applyMcpStatus = (status: Record<string, McpStatus> | undefined) => {

    if (!status) return

    queryClient.setQueryData(queryOptions.mcp(pathKey(sdk.directory)).queryKey, (current) => ({

      ...(typeof current === "object" && current ? current : {}),

      ...status,

    }))

  }



  const mcpStatusFromAdd = (result: { data?: Record<string, McpStatus> }, name: string) => {

    const status = result.data?.[name]

    if (!status) throw new Error("Server did not return MCP status.")

    if (status.status === "failed") throw new Error(status.error ?? "Could not connect this MCP server.")

    return status

  }



  const installWithEnv = async (entry: MarketEntry, env: Record<string, string>, mode: ConfigureMode) => {

    const response = await fetch(`${sdk.url}/codegoblin/market/install`, {

      method: "POST",

      headers: headers(),

      body: JSON.stringify({ id: entry.id, env }),

    })

    const body = (await response.json().catch(() => undefined)) as

      | { ok?: boolean; name?: string; config?: any; message?: string }

      | undefined

    if (!response.ok || !body?.ok || !body.config) {
      throw new Error(body?.message ?? `Could not install ${entry.name}.`)
    }

    const name = body.name ?? entry.id

    const connectInstalled = async () => {
      await sdk.client.mcp.disconnect({ name }).catch(() => undefined)
      const addResult = await sdk.client.mcp.add({ name, config: body.config })
      if ("error" in addResult && addResult.error) {
        const message =
          typeof addResult.error === "object" &&
          addResult.error &&
          "message" in addResult.error &&
          typeof addResult.error.message === "string"
            ? addResult.error.message
            : undefined
        throw new Error(message ?? `Could not connect ${entry.name}.`)
      }
      const status = mcpStatusFromAdd(addResult, name)
      applyMcpStatus(addResult.data)
      return status
    }

    if (mode === "install") {

      const status = await connectInstalled()

      if (status.status === "needs_auth" || status.status === "needs_client_registration") {

        await sdk.client.mcp.auth.authenticate({ name })

        showToast({

          title: `${entry.name} added`,

          description: "Complete sign-in in your browser.",

        })

        return

      }

    } else {

      await connectInstalled()

    }

    showToast({

      title: `${entry.name} ${mode === "install" ? "added" : "updated"}`,

      description:

        entry.id === "firebase"

          ? "Installed globally. The MCP server uses your Firebase CLI login — ask the agent to use firebase_get_environment to verify."

          : "Installed globally and connected.",

    })

  }



  const action = useMutation(() => ({

    mutationFn: async (input: {

      entry: MarketEntry

      action: MarketAction

      env?: Record<string, string>

      configureMode?: ConfigureMode

    }) => {

      const { entry } = input

      if (input.action === "add" || input.action === "configure") {

        if (!input.env) throw new Error("Missing configuration values.")

        await installWithEnv(entry, input.env, input.configureMode ?? "install")

        return

      }

      if (input.action === "remove") {

        const response = await fetch(`${sdk.url}/codegoblin/market/uninstall`, {

          method: "POST",

          headers: headers(),

          body: JSON.stringify({ id: entry.id }),

        })

        const body = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; removedFromConfig?: boolean; message?: string }
          | undefined

        if (!response.ok || !body?.ok) {

          throw new Error(body?.message ?? "Could not remove this server.")

        }

        await queryClient.refetchQueries(queryOptions.mcp(pathKey(sdk.directory)))

        await refetchCatalog()

        queryClient.setQueryData(queryOptions.mcp(pathKey(sdk.directory)).queryKey, (current) => {

          if (!current || typeof current !== "object") return current

          const next = { ...current }

          delete next[entry.id]

          return next

        })

        setConfiguring(undefined)

        showToast({
          title: `${entry.name} removed`,
          description: body.removedFromConfig
            ? "Removed from global config."
            : "Removed from this workspace.",
        })

        return

      }

      if (input.action === "firebase-login") {

        const response = await fetch(`${sdk.url}/codegoblin/market/firebase-login`, {

          method: "POST",

          headers: headers(),

        })

        const body = (await response.json().catch(() => undefined)) as

          | { ok?: boolean; alreadyLoggedIn?: boolean; email?: string; message?: string }

          | undefined

        if (!response.ok || !body?.ok) {

          throw new Error(body?.message ?? "Could not open Firebase sign-in.")

        }

        if (body.alreadyLoggedIn) {

          showToast({

            title: "Firebase CLI ready",

            description: body.email

              ? `Already signed in as ${body.email}. The Firebase MCP can use this account.`

              : "Already signed in. The Firebase MCP can use your CLI credentials.",

          })

          return

        }

        showToast({

          title: "Firebase CLI sign-in",

          description: "Complete login in your browser when the Firebase CLI opens it.",

        })

        return

      }

      if (input.action === "authenticate") {

        await sdk.client.mcp.auth.authenticate({ name: entry.id })

        showToast({ title: `Authenticating ${entry.name}`, description: "Complete sign-in in your browser." })

        return

      }

      if (input.action === "connect") {

        if (entry.needsEnv) {

          throw new Error("Configure this server with an API token before connecting.")

        }

        await sdk.client.mcp.connect({ name: entry.id })

        return

      }

    },

    onSuccess: () => {

      void refetchCatalog()

      refresh()

    },

    onError: (error) =>

      showToast({ variant: "error", icon: "circle-x", title: error instanceof Error ? error.message : "Action failed" }),

  }))



  const openConfigure = (entry: MarketEntry, mode: ConfigureMode) => {

    setConfigureMode(mode)

    setConfiguring(entry)

  }



  const promptInstall = (entry: MarketEntry) => {

    if (entry.env?.length) {

      openConfigure(entry, "install")

      return

    }

    action.mutate({ entry, action: "add", env: {}, configureMode: "install" })

  }



  const items = createMemo(() => catalog() ?? [])

  const activeEntry = () => configuring()



  return (

    <Dialog
      fit={!!activeEntry()}
      title={activeEntry() ? `Configure ${activeEntry()!.name}` : "Market"}
      description={
        activeEntry()
          ? "Credentials are saved to your global CodeGoblin config."
          : "Install MCP servers globally (available in every project). Connect, authenticate, or remove."
      }
    >

      <Show

        when={activeEntry()}

        fallback={

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

              const status = () => {

                if (entry.installed === false) return undefined

                return sync.data.mcp?.[entry.id]?.status

              }

              const statusLabel = () => {

                if (!sync.data.mcp_ready) return statusLabels.connecting

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

                    { action: "remove", label: "Remove", variant: "ghost" },

                  ]

                if (entry.needsEnv)

                  return [

                    { action: "configure", label: "Configure", variant: "primary" },

                    { action: "remove", label: "Remove", variant: "ghost" },

                  ]

                if (s === "connected")

                  return isRemote()

                    ? [

                        { action: "authenticate", label: "Re-authenticate", variant: "ghost" },

                        { action: "remove", label: "Remove", variant: "ghost" },

                      ]

                    : [{ action: "remove", label: "Remove", variant: "ghost" }]

                return isRemote()

                  ? [

                      { action: "connect", label: "Connect", variant: "primary" },

                      { action: "authenticate", label: "Authenticate", variant: "ghost" },

                      { action: "remove", label: "Remove", variant: "ghost" },

                    ]

                  : entry.id === "firebase"

                    ? [

                        { action: "connect", label: "Connect", variant: "primary" },

                        { action: "firebase-login", label: "CLI sign-in", variant: "ghost" },

                        { action: "remove", label: "Remove", variant: "ghost" },

                      ]

                    : [

                        { action: "connect", label: "Connect", variant: "primary" },

                        { action: "remove", label: "Remove", variant: "ghost" },

                      ]

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

                            if (item.action === "add") {

                              promptInstall(entry)

                              return

                            }

                            if (item.action === "configure") {

                              openConfigure(entry, entry.needsEnv && status() ? "reconfigure" : "install")

                              return

                            }

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

        }

      >

        {(entry) => (

          <MarketConfigureForm

            entry={entry()}

            pending={action.isPending}

            submitLabel={configureMode() === "install" ? "Install" : "Save & connect"}

            onBack={() => setConfiguring(undefined)}

            onInstall={(env) => {

              action.mutate(

                {

                  entry: entry(),

                  action: configureMode() === "install" ? "add" : "configure",

                  env,

                  configureMode: configureMode(),

                },

                { onSuccess: () => setConfiguring(undefined) },

              )

            }}

          />

        )}

      </Show>

    </Dialog>

  )

}


