import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
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
    const previousCodeGoblin = process.env.CODEGOBLIN_ELEVENLABS_API_KEY
    const previousDisableAuth = process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-missing-"))
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.CODEGOBLIN_ELEVENLABS_API_KEY
    process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH = "1"
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        output: "codegoblin-output/audio/test.mp3",
        keyFile: "missing.env",
        cwd: root,
      })

      expect(result.ok).toBe(false)
      expect(result.message).toContain("No ElevenLabs key found")
      expect(result.message).toContain("did not send")
    } finally {
      if (previous === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = previous
      if (previousCodeGoblin === undefined) delete process.env.CODEGOBLIN_ELEVENLABS_API_KEY
      else process.env.CODEGOBLIN_ELEVENLABS_API_KEY = previousCodeGoblin
      if (previousDisableAuth === undefined) delete process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH
      else process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH = previousDisableAuth
      await rm(root, { recursive: true, force: true })
    }
  })

  test("loads a CodeGoblin ElevenLabs key from a parent env and sends audio settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-env-"))
    const project = path.join(root, "project")
    await mkdir(project)
    await writeFile(path.join(root, ".env"), "CODEGOBLIN_ELEVENLABS_API_KEY=test-eleven-key\n")
    const previousFetch = globalThis.fetch
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: url.toString(), init })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as typeof fetch
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        output: "codegoblin-output/audio/test.mp3",
        cwd: project,
        model: "eleven_multilingual_v2",
        voice: "voice_test",
        outputFormat: "mp3_22050_32",
        voiceSettings: {
          stability: 0.4,
          similarityBoost: 0.8,
          style: 0.2,
          speed: 1.05,
          useSpeakerBoost: false,
        },
        languageCode: "en",
        seed: 123,
        applyTextNormalization: "auto",
      })

      expect(result.ok).toBe(true)
      expect(result.output).toBe(path.join(project, "codegoblin-output/audio/test.mp3"))
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toContain("/v1/text-to-speech/voice_test?")
      expect(requests[0]!.url).toContain("output_format=mp3_22050_32")
      expect(new Headers(requests[0]!.init?.headers).get("xi-api-key")).toBe("test-eleven-key")
      expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
        text: "hello goblin",
        model_id: "eleven_multilingual_v2",
        language_code: "en",
        seed: 123,
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
          style: 0.2,
          speed: 1.05,
          use_speaker_boost: false,
        },
        apply_text_normalization: "auto",
      })
      expect(await Bun.file(result.output!).bytes()).toEqual(new Uint8Array([1, 2, 3]))
    } finally {
      globalThis.fetch = previousFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  test("auto-selects a generated account voice when no voice is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-auto-"))
    await writeFile(path.join(root, ".env"), "ELEVENLABS_API_KEY=test-eleven-key\n")
    const previousFetch = globalThis.fetch
    const previousVoice = process.env.ELEVENLABS_VOICE_ID
    const previousCodeGoblinVoice = process.env.CODEGOBLIN_ELEVENLABS_VOICE_ID
    delete process.env.ELEVENLABS_VOICE_ID
    delete process.env.CODEGOBLIN_ELEVENLABS_VOICE_ID
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: url.toString(), init })
      if (url.toString().includes("/v2/voices")) {
        return Response.json({
          voices: [
            { voice_id: "premade_voice", category: "premade" },
            { voice_id: "generated_voice", category: "generated" },
          ],
        })
      }
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 })
    }) as typeof fetch
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        output: "codegoblin-output/audio/test.mp3",
        cwd: root,
      })

      expect(result.ok).toBe(true)
      expect(result.voice).toBe("generated_voice")
      expect(requests[0]?.url).toBe("https://api.elevenlabs.io/v2/voices?page_size=100")
      expect(requests[1]?.url).toContain("/v1/text-to-speech/generated_voice?")
    } finally {
      globalThis.fetch = previousFetch
      if (previousVoice === undefined) delete process.env.ELEVENLABS_VOICE_ID
      else process.env.ELEVENLABS_VOICE_ID = previousVoice
      if (previousCodeGoblinVoice === undefined) delete process.env.CODEGOBLIN_ELEVENLABS_VOICE_ID
      else process.env.CODEGOBLIN_ELEVENLABS_VOICE_ID = previousCodeGoblinVoice
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lists ElevenLabs speakers for settings UI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-voices-"))
    await writeFile(path.join(root, ".env"), "ELEVENLABS_API_KEY=test-eleven-key\n")
    const previousFetch = globalThis.fetch
    const previousKey = process.env.ELEVENLABS_API_KEY
    const previousCodeGoblinKey = process.env.CODEGOBLIN_ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.CODEGOBLIN_ELEVENLABS_API_KEY
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: url.toString(), init })
      return Response.json({
        voices: [
          {
            voice_id: "generated_voice",
            name: "Goblin Narrator",
            category: "generated",
            description: "raspy but friendly",
            preview_url: "https://example.com/preview.mp3",
            labels: { accent: "american", gender: "neutral", ignored: 42 },
          },
          { name: "missing id" },
        ],
      })
    }) as typeof fetch
    try {
      const result = await CodeGoblinAudioCommand.voices({ cwd: root })

      expect(result.ok).toBe(true)
      expect(requests[0]?.url).toBe("https://api.elevenlabs.io/v2/voices?page_size=100")
      expect(new Headers(requests[0]!.init?.headers).get("xi-api-key")).toBe("test-eleven-key")
      expect(result.voices).toEqual([
        {
          id: "generated_voice",
          name: "Goblin Narrator",
          category: "generated",
          description: "raspy but friendly",
          previewUrl: "https://example.com/preview.mp3",
          labels: { accent: "american", gender: "neutral" },
        },
      ])
    } finally {
      globalThis.fetch = previousFetch
      if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = previousKey
      if (previousCodeGoblinKey === undefined) delete process.env.CODEGOBLIN_ELEVENLABS_API_KEY
      else process.env.CODEGOBLIN_ELEVENLABS_API_KEY = previousCodeGoblinKey
      await rm(root, { recursive: true, force: true })
    }
  })

  test("dry-runs Google Cloud TTS with a .wav extension default", async () => {
    const result = await CodeGoblinAudioCommand.generate({
      text: "hello goblin",
      provider: "google",
      model: "google-tts",
      outputFormat: "LINEAR16",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe("google")
    expect(result.model).toBe("neural2")
    expect(result.outputFormat).toBe("LINEAR16")
    expect(result.message).toContain("google/neural2")
  })

  test("generates audio through Google Cloud TTS and decodes base64", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-google-"))
    await writeFile(path.join(root, ".env"), "GOOGLE_CLOUD_TTS_API_KEY=test-google-key\n")
    const previousFetch = globalThis.fetch
    const requests: { url: string; init?: RequestInit }[] = []
    const audioBytes = new Uint8Array([7, 8, 9])
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: url.toString(), init })
      return Response.json({ audioContent: Buffer.from(audioBytes).toString("base64") })
    }) as typeof fetch
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        provider: "google",
        output: "codegoblin-output/audio/test.mp3",
        voice: "en-US-Neural2-C",
        cwd: root,
        voiceSettings: { speed: 1.5 },
      })

      expect(result.ok).toBe(true)
      expect(result.provider).toBe("google")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toContain("texttospeech.googleapis.com/v1/text:synthesize?key=test-google-key")
      expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
        input: { text: "hello goblin" },
        voice: { languageCode: "en-US", name: "en-US-Neural2-C" },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.5 },
      })
      expect(await Bun.file(result.output!).bytes()).toEqual(audioBytes)
    } finally {
      globalThis.fetch = previousFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns a friendly missing key error for Google without calling the provider", async () => {
    const previousGoogle = process.env.GOOGLE_CLOUD_TTS_API_KEY
    const previousApi = process.env.GOOGLE_API_KEY
    const previousCodeGoblin = process.env.CODEGOBLIN_GOOGLE_TTS_API_KEY
    const previousDisableAuth = process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-audio-google-missing-"))
    delete process.env.GOOGLE_CLOUD_TTS_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.CODEGOBLIN_GOOGLE_TTS_API_KEY
    process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH = "1"
    try {
      const result = await CodeGoblinAudioCommand.generate({
        text: "hello goblin",
        provider: "google",
        output: "codegoblin-output/audio/test.mp3",
        keyFile: "missing.env",
        cwd: root,
      })

      expect(result.ok).toBe(false)
      expect(result.message).toContain("No Google Cloud TTS key found")
      expect(result.message).toContain("did not send")
    } finally {
      if (previousGoogle === undefined) delete process.env.GOOGLE_CLOUD_TTS_API_KEY
      else process.env.GOOGLE_CLOUD_TTS_API_KEY = previousGoogle
      if (previousApi === undefined) delete process.env.GOOGLE_API_KEY
      else process.env.GOOGLE_API_KEY = previousApi
      if (previousCodeGoblin === undefined) delete process.env.CODEGOBLIN_GOOGLE_TTS_API_KEY
      else process.env.CODEGOBLIN_GOOGLE_TTS_API_KEY = previousCodeGoblin
      if (previousDisableAuth === undefined) delete process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH
      else process.env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH = previousDisableAuth
      await rm(root, { recursive: true, force: true })
    }
  })
})