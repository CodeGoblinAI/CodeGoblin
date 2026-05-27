import { describe, expect, test } from "bun:test"
import { CodeGoblinAudioCommand } from "@/codegoblin/audio-command"

describe("CodeGoblin audio command", () => {
  test("dry-runs ElevenLabs audio output planning", async () => {
    const result = await CodeGoblinAudioCommand.generate({
      text: "hello goblin",
      output: "codegoblin-output/audio/test.mp3",
      model: "elevenlabs-tts",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe("elevenlabs")
    expect(result.model).toBe("eleven_turbo_v2_5")
    expect(result.message).toContain("elevenlabs/eleven_turbo_v2_5")
  })

  test("rejects audio output paths outside the project", () => {
    expect(() =>
      CodeGoblinAudioCommand.describe({
        text: "hello goblin",
        output: "../outside.mp3",
        cwd: process.cwd(),
      }),
    ).toThrow("Audio output path must stay inside the current project directory.")
  })

  test("returns a friendly missing key error without calling the provider", async () => {
    const previous = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        output: "codegoblin-output/audio/test.mp3",
        keyFile: "missing.env",
        cwd: process.cwd(),
      })

      expect(result.ok).toBe(false)
      expect(result.message).toContain("No ElevenLabs key found")
      expect(result.message).toContain("did not send")
    } finally {
      if (previous === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = previous
    }
  })
})