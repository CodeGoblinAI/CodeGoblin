import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@codegoblin/ui/context"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  favorite?: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        favorite: [],
        variant: {},
      }),
    )

    // --- shared favorites (TUI <-> web) -------------------------------------
    // The TUI keeps favorites in <state>/model.json on the server machine; the
    // /codegoblin/model-favorites routes expose that file so both surfaces see
    // the same stars. Web localStorage stays the fast local cache; the server
    // file is the shared source of truth.
    const favoritesRequest = (init?: RequestInit) =>
      fetch(`${globalSDK.url}/codegoblin/model-favorites`, {
        ...init,
        headers: {
          "x-opencode-directory": globalSync.data.path.directory ?? "",
          ...init?.headers,
        },
      })

    const plainFavorites = (items: ModelKey[]) =>
      items.map((x) => ({ providerID: x.providerID, modelID: x.modelID }))

    const pushFavorites = (favorite: ModelKey[]) => {
      void favoritesRequest({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favorite: plainFavorites(favorite) }),
      }).catch(() => {})
    }

    // Hydrate once after localStorage is loaded: union the server (TUI) list
    // with the local one so neither side loses stars on first sync, then push
    // the merged list back so the shared file becomes authoritative.
    let hydrated = false
    createEffect(() => {
      if (!ready() || hydrated) return
      hydrated = true
      void (async () => {
        try {
          const response = await favoritesRequest()
          if (!response.ok) return
          const data = (await response.json()) as { favorite?: ModelKey[] }
          if (!Array.isArray(data.favorite)) return
          const remote = data.favorite.filter(
            (x) => x && typeof x.providerID === "string" && typeof x.modelID === "string",
          )
          const merged = uniqueBy([...remote, ...(store.favorite ?? [])], modelKey)
          const changed =
            merged.length !== (store.favorite ?? []).length ||
            merged.some((x, i) => modelKey(x) !== modelKey((store.favorite ?? [])[i]!))
          if (changed) setStore("favorite", merged)
          if (merged.length !== remote.length) pushFavorites(merged)
        } catch {
          // Server route unavailable (older server, remote access) — stay local.
        }
      })()
    })

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const favoriteList = createMemo(() => store.favorite ?? [])
    const favoriteSet = createMemo(() => new Set(favoriteList().map(modelKey)))
    const isFavorite = (model: ModelKey) => favoriteSet().has(modelKey(model))
    const toggleFavorite = (model: ModelKey) => {
      const key = modelKey(model)
      const current = store.favorite ?? []
      const next = current.some((x) => modelKey(x) === key)
        ? current.filter((x) => modelKey(x) !== key)
        : [{ providerID: model.providerID, modelID: model.modelID }, ...current]
      setStore("favorite", next)
      // Write through to the shared server file so the TUI sees it too.
      pushFavorites(next)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      favorite: {
        list: favoriteList,
        has: isFavorite,
        toggle: toggleFavorite,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
