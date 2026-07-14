import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { codeGoblinBrandPalette } from "../../../src/cli/cmd/tui/component/codegoblin-brand"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/cli/cmd/tui/context/theme"

test("CodeGoblin branding reacts to the active theme palette", () => {
  const codegoblin = codeGoblinBrandPalette(resolveTheme(DEFAULT_THEMES.codegoblin, "dark"))
  const dracula = codeGoblinBrandPalette(resolveTheme(DEFAULT_THEMES.dracula, "dark"))

  expect(codegoblin.skin).not.toEqual(dracula.skin)
  expect(codegoblin.vest).not.toEqual(dracula.vest)
  expect(codegoblin.facet).not.toEqual(dracula.facet)
  expect(codegoblin.skin).toEqual(resolveTheme(DEFAULT_THEMES.codegoblin, "dark").primary)
  expect(dracula.skin).toEqual(resolveTheme(DEFAULT_THEMES.dracula, "dark").primary)

  createRoot((dispose) => {
    const [theme, setTheme] = createSignal(resolveTheme(DEFAULT_THEMES.codegoblin, "dark"))
    const palette = createMemo(() => codeGoblinBrandPalette(theme()))

    expect(palette().skin).toEqual(codegoblin.skin)
    setTheme(resolveTheme(DEFAULT_THEMES.dracula, "dark"))
    expect(palette().skin).toEqual(dracula.skin)
    dispose()
  })
})
