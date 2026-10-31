import { describe, expect, test } from "bun:test"
import { keymapFrom } from "../src/tui/keybinds"

describe("tui.json keybinds (the fork's file)", () => {
  test("without any, ctrl+x and the fork's default letters", () => {
    const map = keymapFrom({})
    expect(map.leader).toBe("x")
    expect(map.letters.m).toBe("model")
    expect(map.letters.q).toBe("quit")
    expect(map.problems).toEqual([])
  })

  test("a new leader, a moved shortcut, two letters for one, and one switched off", () => {
    const map = keymapFrom({ keybinds: { leader: "ctrl+b", model_list: "<leader>k", session_new: "<leader>n,<leader>o", app_exit: "none" } })
    expect(map.leader).toBe("b")
    expect(map.letters.k).toBe("model")
    expect(map.letters.m).toBeUndefined()
    expect(map.letters.o).toBe("new")
    expect(map.letters.q).toBeUndefined()
  })

  test("what it cannot use is reported and the default kept", () => {
    const map = keymapFrom({ keybinds: { leader: "ctrl+c", model_list: "alt+m", theme_list: 3 } })
    expect(map.leader).toBe("x")
    expect(map.letters.m).toBe("model")
    expect(map.letters.t).toBe("theme")
    expect(map.problems.length).toBe(3)
  })
})
