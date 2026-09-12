import { describe, expect, test } from "bun:test"
import { parseLaunch } from "../src/tui/args"

describe("starting the terminal", () => {
  test("nothing named means nothing chosen", () => {
    expect(parseLaunch([])).toEqual({ directory: undefined, model: undefined })
  })

  test("--model picks a model and is not mistaken for a directory", () => {
    // The regression: this exited with "cannot open zai/glm-5.3".
    expect(parseLaunch(["--model", "zai/glm-5.3"])).toEqual({ directory: undefined, model: "zai/glm-5.3" })
  })

  test("a directory on its own still moves the sandbox", () => {
    expect(parseLaunch(["../other-project"])).toEqual({ directory: "../other-project", model: undefined })
  })

  test("both together, in either order", () => {
    const expected = { directory: "../proj", model: "tripo/text-to-model" }
    expect(parseLaunch(["../proj", "--model", "tripo/text-to-model"])).toEqual(expected)
    expect(parseLaunch(["--model", "tripo/text-to-model", "../proj"])).toEqual(expected)
  })

  test("--provider still works, and --model wins when both are given", () => {
    expect(parseLaunch(["--provider", "zai"]).model).toBe("zai")
    expect(parseLaunch(["--provider", "zai", "--model", "deepseek/deepseek-v4-pro"]).model).toBe("deepseek/deepseek-v4-pro")
  })

  test("a flag with no value is ignored rather than eating the next flag", () => {
    expect(parseLaunch(["--model"])).toEqual({ directory: undefined, model: undefined })
    expect(parseLaunch(["--model", "--provider", "zai"]).model).toBe("zai")
  })

  test("the first directory named is the one used", () => {
    expect(parseLaunch(["one", "two"]).directory).toBe("one")
  })
})
