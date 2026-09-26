/**
 * Registration and execution tests for the two media tools.
 *
 * These mount the REAL `@deepseek-ai/dsh-tools` registry into a real Cordis
 * context and drive the definitions through `execute` + `output.render`, which
 * is the pair of calls the agent loop makes. That is deliberate: the things most
 * likely to break in this plugin are the parts a mocked registry would hide —
 * whether the output schema is accepted by `assertSupportedJsonSchema`, whether
 * the canonical value actually validates, and whether the rendered blocks carry
 * an image the attachment store will accept.
 *
 * The only doubles are the two services this plugin reads, so nothing here
 * touches the network, a Comate account, or a generation budget.
 *
 * @module dsh-comate-media/tests/plugin.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import * as mediaPlugin from '../src/index.ts'
import { GENERATE_IMAGE_TOOL } from '../src/tools/generate-image.ts'
import { GENERATE_VIDEO_TOOL } from '../src/tools/generate-video.ts'
import { ONE_PIXEL_PNG, createFakeAttachments, createFakeMedia, createFakeSession } from './fakes.ts'
import type { FakeAttachments, FakeMedia, FakeMediaBehavior, FakeSession } from './fakes.ts'

/** The subset of a registered definition these tests read. */
interface AnyTool {
  readonly name: string
  readonly description: string
  /** The COMPILED JSON Schema the model sees, not the author-facing DSL. */
  readonly parameters: {
    readonly type: string
    readonly properties: Record<string, { type: string; enum?: readonly string[]; description?: string }>
    readonly required?: readonly string[]
  }
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: {
      readonly type: string
      readonly required?: readonly string[]
      readonly properties: Record<string, unknown>
    }
    /* eslint-disable @typescript-eslint/no-explicit-any -- the canonical value is schema-derived and asserted field by field. */
    render(args: unknown, value: any): ContentBlock[]
  }
  execute(args: unknown, exec: any): Promise<any>
}

/** Harness inputs. */
interface HarnessOptions {
  imageTimeoutMs: number
  videoTimeoutMs: number
  saveToDisk: boolean
  /** Mount a fake `attachments`. Turn off to exercise the no-store path. */
  withAttachments: boolean
  /**
   * Mount through the shipped `apply()` instead of the registration step.
   *
   * `apply()` builds its own client, so it cannot take the substitute one — and
   * that is the point: this switch exists so one test can prove the entry itself
   * registers the same tools, without the rest of the suite losing its fake.
   */
  useEntry: boolean
  /** Mount a fake `sessionProjections` with an open turn. */
  withOpenTurn: boolean
  /** The Session working directory, or `undefined` for a workspace-less Session. */
  cwd: string | undefined
  mediaImage: FakeMediaBehavior
  mediaVideo: FakeMediaBehavior
}

/** The shipped-behavior defaults, so a test states only what it changes. */
const DEFAULTS: HarnessOptions = {
  imageTimeoutMs: 5_000,
  videoTimeoutMs: 5_000,
  saveToDisk: true,
  withAttachments: true,
  useEntry: false,
  withOpenTurn: true,
  cwd: undefined,
  mediaImage: 'ok',
  mediaVideo: 'ok',
}

/** One mounted plugin composition. */
interface Harness {
  ctx: Context
  tools: ToolRuntime
  attachments: FakeAttachments
  media: FakeMedia
  session: FakeSession
  /** Absolute path of a temporary directory the test may write into. */
  dir: string
  /** Read one registered definition, failing loudly when it is absent. */
  tool(name: string): AnyTool
  /** A `ToolRunContext` double for `execute`. */
  execution(signal?: AbortSignal): unknown
}

/** Temporary directories created during the run, cleaned up afterwards. */
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Mount the plugin over real services.
 *
 * @param overrides - the fields to change from {@link DEFAULTS}.
 * @returns the mounted composition.
 */
async function createHarness(overrides: Partial<HarnessOptions> = DEFAULTS): Promise<Harness> {
  const options: HarnessOptions = { ...DEFAULTS, ...overrides }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comate-media-'))
  created.push(dir)

  const attachments = createFakeAttachments()
  const media = createFakeMedia({ image: options.mediaImage, video: options.mediaVideo })
  const session = createFakeSession(options.cwd ?? join(dir, 'workspace'))

  const ctx = new Context()

  // `dsh-tools` injects `systemPrompt`; a structural double satisfies it.
  await ctx.plugin({
    name: 'test-system-prompt',
    apply(fiber: Context) {
      fiber.provide('systemPrompt', {
        tools: () => undefined,
        getSectionOrder: () => 0,
      })
    },
  })

  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })

  if (options.withAttachments) {
    await ctx.plugin({
      name: 'test-attachments',
      apply(fiber: Context) {
        fiber.provide('attachments', attachments.service)
      },
    })
  }

  if (options.withOpenTurn) {
    await ctx.plugin({
      name: 'test-session-projections',
      apply(fiber: Context) {
        fiber.provide('sessionProjections', {
          stateOf: () => ({ lastTurn: 1, openTurnStartSeq: 0 }),
        })
      },
    })
  }

  const config = {
    outputDir: dir,
    imageTimeoutMs: options.imageTimeoutMs,
    videoTimeoutMs: options.videoTimeoutMs,
    saveToDisk: options.saveToDisk,
  }
  if (options.useEntry) {
    await ctx.plugin(mediaPlugin, config)
  } else {
    // Mounted through the plugin's own registration step with a substitute
    // client, so the Config-to-options mapping under test is the shipped one.
    await ctx.plugin({
      name: 'test-mount-comate-media',
      // The shipped `inject` list, so `fiber.tools` is present exactly as it is
      // for the real entry.
      inject: ['tools'],
      apply(fiber: Context) {
        mediaPlugin.mount(fiber, config, media.service)
      },
    })
  }

  const tools = ctx.get('tools') as ToolRuntime

  return {
    ctx,
    tools,
    attachments,
    media,
    session,
    dir,
    tool(name: string): AnyTool {
      const found = tools.get(name)
      if (found === undefined) throw new Error(`tool "${name}" is not registered`)
      return found as unknown as AnyTool
    },
    execution(signal?: AbortSignal): unknown {
      return {
        signal: signal ?? new AbortController().signal,
        callId: 'call-test-1',
        agent: { session },
      }
    },
  }
}

describe('registration', () => {
  it('registers both tools with the model-facing parameter contract', async () => {
    const harness = await createHarness()

    const names = harness.tools.schemas().map((schema) => schema.name).sort()
    expect(names).toEqual([GENERATE_IMAGE_TOOL, GENERATE_VIDEO_TOOL])

    const image = harness.tool(GENERATE_IMAGE_TOOL)
    expect(image.parameters.properties.prompt?.type).toBe('string')
    expect(image.parameters.required).toContain('prompt')
    expect(image.parameters.properties.size?.type).toBe('string')
    expect(image.parameters.properties.model?.type).toBe('string')
    // The image block is optional, because the tool must still succeed when no
    // attachment store is mounted.
    expect(image.output.schema.required ?? []).not.toContain('image')

    const video = harness.tool(GENERATE_VIDEO_TOOL)
    expect(video.parameters.properties.prompt?.type).toBe('string')
    expect(video.parameters.required).toContain('prompt')
    expect(video.parameters.properties.size?.enum).toEqual(['480p', '720p', '1080p'])
    expect(video.parameters.properties.seconds?.type).toBe('string')
  })

  it('declares the configured deadlines so the registry can report them', async () => {
    const harness = await createHarness({ imageTimeoutMs: 1_234, videoTimeoutMs: 5_678 })
    expect(harness.tool(GENERATE_IMAGE_TOOL).timeoutMs).toBe(1_234)
    expect(harness.tool(GENERATE_VIDEO_TOOL).timeoutMs).toBe(5_678)
  })

  it('mounts through the shipped apply(), wiring the same two tools', async () => {
    // The one test that goes through the real entry point. apply() builds its
    // own client and therefore cannot take the substitute one, which is exactly
    // why the rest of the suite mounts through `mount` instead — this proves the
    // entry registers the same tools with the same configured deadlines.
    const harness = await createHarness({ useEntry: true, imageTimeoutMs: 1_234, videoTimeoutMs: 5_678 })
    const names = harness.tools.schemas().map((schema) => schema.name)
    expect(names).toContain(GENERATE_IMAGE_TOOL)
    expect(names).toContain(GENERATE_VIDEO_TOOL)
    expect(harness.tool(GENERATE_IMAGE_TOOL).timeoutMs).toBe(1_234)
    expect(harness.tool(GENERATE_VIDEO_TOOL).timeoutMs).toBe(5_678)
  })
})

describe('comate_generate_image', () => {
  it('generates, commits the attachment, writes the file, and returns an image block', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    const value = await tool.execute({ prompt: 'a red circle on white' }, harness.execution())

    expect(value.media_type).toBe('image/jpeg')
    expect(value.bytes).toBe(ONE_PIXEL_PNG.byteLength)
    expect(value.width).toBe(960)
    expect(value.height).toBe(960)
    expect(value.model).toBe('fake-image-model')
    expect(value.revised_prompt).toBe('a red circle on white, centered')

    // Committed through the attachment service with the SNIFFED type, not the
    // octet-stream the real gateway declares.
    expect(harness.attachments.saves).toHaveLength(1)
    expect(harness.attachments.saves[0]?.mediaType).toBe('image/jpeg')
    expect(Buffer.from(harness.attachments.saves[0]?.data ?? [])).toEqual(Buffer.from(ONE_PIXEL_PNG))

    // And a durable copy on disk, whose name ends in the sniffed extension.
    expect(value.path).toBeTypeOf('string')
    expect(value.path.endsWith('.jpg')).toBe(true)
    expect(await readFile(value.path)).toEqual(Buffer.from(ONE_PIXEL_PNG))

    const blocks = tool.output.render({ prompt: 'a red circle on white' }, value)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: 'text',
      text: [
        `Generated an image: 960x960 image/jpeg, ${ONE_PIXEL_PNG.byteLength} bytes.`,
        `Saved to ${value.path}`,
        'Model: fake-image-model',
        'Upstream prompt: a red circle on white, centered',
      ].join('\n'),
    })
    expect(blocks[1]?.type).toBe('image')
    expect(blocks[1]).toMatchObject({
      attachment: { attachmentId: 'fake-attachment-1', mediaType: 'image/jpeg', width: 960, height: 960 },
    })
  })

  it('declares the saved file as a deliverable on the open turn', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_IMAGE_TOOL)
    const value = await tool.execute({ prompt: 'a red circle' }, harness.execution())

    expect(harness.session.events).toHaveLength(1)
    expect(harness.session.events[0]?.event).toBe('deliverables/presented')
    expect(harness.session.events[0]?.payload).toMatchObject({
      turn: 1,
      callId: 'call-test-1',
      files: [{ path: value.path }],
    })
  })

  it('forwards size and model, and omits them when the caller does not set them', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    await tool.execute({ prompt: 'a red circle', size: '1024x768', model: 'seedream-4' }, harness.execution())
    expect(harness.media.imageRequests[0]).toEqual({
      prompt: 'a red circle',
      size: '1024x768',
      model: 'seedream-4',
    })

    await tool.execute({ prompt: 'a red circle' }, harness.execution())
    expect(harness.media.imageRequests[1]).toEqual({ prompt: 'a red circle' })
  })

  it('rejects a blank prompt before reaching the service', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    await expect(tool.execute({ prompt: '   ' }, harness.execution())).rejects.toThrow('prompt must be a non-empty string')
    expect(harness.media.imageRequests).toHaveLength(0)
  })

  it('still returns the file when no attachment store is mounted', async () => {
    const harness = await createHarness({ withAttachments: false })
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    const value = await tool.execute({ prompt: 'a red circle' }, harness.execution())

    expect(value.image).toBeUndefined()
    expect(await readFile(value.path)).toEqual(Buffer.from(ONE_PIXEL_PNG))
    const blocks = tool.output.render({ prompt: 'a red circle' }, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
  })

  it('skips the disk copy when saveToDisk is off, keeping the attachment', async () => {
    const harness = await createHarness({ saveToDisk: false })
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    const value = await tool.execute({ prompt: 'a red circle' }, harness.execution())

    expect(value.path).toBeUndefined()
    expect(harness.attachments.saves).toHaveLength(1)
    expect(harness.session.events).toHaveLength(0)
  })

  it('cancels a generation that outlives its own deadline', async () => {
    const harness = await createHarness({ mediaImage: 'hang', imageTimeoutMs: 40 })
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    await expect(tool.execute({ prompt: 'a red circle' }, harness.execution()))
      .rejects.toThrow('image generation did not finish within 40ms and was cancelled')
  })

  it('does not rewrite a caller cancellation as a timeout', async () => {
    const harness = await createHarness({ mediaImage: 'cancel' })
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    // The client rejects with whatever reason the caller's signal carries,
    // which is what a well-behaved downstream does when the user presses stop.
    const stop = new Error('the user stopped this turn')
    const controller = new AbortController()
    const pending = tool.execute({ prompt: 'a red circle' }, harness.execution(controller.signal))
    setTimeout(() => controller.abort(stop), 10)

    await expect(pending).rejects.toThrow('the user stopped this turn')
  })

  it('surfaces an upstream failure unchanged', async () => {
    const harness = await createHarness({ mediaImage: 'fail' })
    const tool = harness.tool(GENERATE_IMAGE_TOOL)

    await expect(tool.execute({ prompt: 'a red circle' }, harness.execution()))
      .rejects.toThrow('upstream refused: not signed in')
  })
})

describe('comate_generate_video', () => {
  it('generates, always writes the file, and declares it', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_VIDEO_TOOL)

    const value = await tool.execute({ prompt: 'a cat on a skateboard' }, harness.execution())

    expect(value.media_type).toBe('video/mp4')
    expect(value.path).toBeTypeOf('string')
    expect(value.path.endsWith('.mp4')).toBe(true)
    expect(value.model).toBe('doubao-seedance-2-0-fast-260128')
    expect(value.task_id).toBe('llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123')
    expect(value.seconds).toBe('5')

    const bytes = await readFile(value.path)
    expect(bytes.byteLength).toBe(4)

    expect(harness.session.events[0]?.event).toBe('deliverables/presented')
    expect(harness.session.events[0]?.payload).toMatchObject({ files: [{ path: value.path }] })

    const blocks = tool.output.render({ prompt: 'a cat on a skateboard' }, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain(`Saved to ${value.path}`)
  })

  it('writes the file even when image disk copies are disabled', async () => {
    const harness = await createHarness({ saveToDisk: false })
    const tool = harness.tool(GENERATE_VIDEO_TOOL)

    const value = await tool.execute({ prompt: 'a cat on a skateboard' }, harness.execution())

    // The file IS the deliverable for a video; `saveToDisk` governs images only.
    expect(value.path).toBeTypeOf('string')
    expect(await readFile(value.path)).toHaveLength(4)
  })

  it('forwards the duration and resolution tier without conflating them', async () => {
    const harness = await createHarness()
    const tool = harness.tool(GENERATE_VIDEO_TOOL)

    await tool.execute({ prompt: 'a cat', seconds: '10', size: '720p' }, harness.execution())

    expect(harness.media.videoRequests[0]).toEqual({ prompt: 'a cat', seconds: '10', size: '720p' })
  })

  it('cancels a generation that outlives its own deadline', async () => {
    const harness = await createHarness({ mediaVideo: 'hang', videoTimeoutMs: 40 })
    const tool = harness.tool(GENERATE_VIDEO_TOOL)

    await expect(tool.execute({ prompt: 'a cat' }, harness.execution()))
      .rejects.toThrow('video generation did not finish within 40ms and was cancelled')
  })

  it('returns the file even when no open turn can carry a deliverable', async () => {
    const harness = await createHarness({ withOpenTurn: false })
    const tool = harness.tool(GENERATE_VIDEO_TOOL)

    const value = await tool.execute({ prompt: 'a cat' }, harness.execution())

    expect(value.path).toBeTypeOf('string')
    expect(harness.session.events).toHaveLength(0)
  })
})
