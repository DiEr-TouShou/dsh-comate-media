/**
 * `comate_generate_video` — text prompt in, short clip out.
 *
 * Structurally different from the image tool in one way that shapes everything
 * else: the gateway generates video ASYNCHRONOUSLY (submit, then poll for up to
 * twenty minutes), so one call here can hold a turn open for minutes. The main
 * plugin hides the polling — it resolves only when the bytes are in hand — which
 * is why this file has no state machine and only needs a deadline.
 *
 * Display is different too, and worse. A generated image can become an
 * `ImageBlock`; a video has no chat-renderable form, because DSH's markdown
 * pipeline rewrites image destinations only and the generic tool card never
 * renders a player. So the local file IS the deliverable: this tool always
 * writes it to disk and declares it, regardless of the `saveToDisk` setting that
 * governs images.
 *
 * @module dsh-comate-media/tools/generate-video
 */

import { tmpdir } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { extensionForMediaType } from '../comate/sniff.ts'
import type { ComateMediaApi, ComateVideoRequest } from '../contract.ts'
import { publishDeliverables, readSessionCwd } from '../deliverables.ts'
import { raceDeadline, withDeadline } from '../signals.ts'
import type { Deadline } from '../signals.ts'
import { saveGeneratedMedia } from '../storage.ts'

/** The model-facing tool name. */
export const GENERATE_VIDEO_TOOL = 'comate_generate_video'

/** Resolution tiers the gateway accepts. */
const RESOLUTION_TIERS = ['480p', '720p', '1080p'] as const

/** Registration inputs the plugin entry owns. */
export interface GenerateVideoOptions {
  /** The Comate client; built once by the plugin entry, credential read per call. */
  api: ComateMediaApi
  /** Cooperative budget for one generation, in milliseconds. */
  timeoutMs: number
  /** Fixed output directory; when absent the Session working directory is used. */
  outputDir: string | undefined
}

/**
 * Register {@link GENERATE_VIDEO_TOOL}.
 *
 * @param ctx - the plugin context; `tools` is injected.
 * @param options - the client, budget, and output location from the plugin config.
 */
export function registerGenerateVideo(ctx: Context, options: GenerateVideoOptions): void {
  ctx.tools.register(defineTool({
    name: GENERATE_VIDEO_TOOL,
    description:
      'Generate a short video clip from a text prompt with the user\'s signed-in WPS Comate account. '
      + 'Use it when the user asks for a video, animation, or moving shot. Generation is asynchronous and '
      + 'typically takes one to three minutes; the call returns only when the clip is ready, so do not '
      + 'retry it on your own while it runs. The saved file is declared as a deliverable the user can open.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What the clip should show, in the language of the user\'s request. Describe subject, action, camera movement, and mood.',
      },
      seconds: {
        type: 'string',
        description: 'Duration in seconds, as a string: "5" or "10". Omit for the default 5.',
      },
      size: {
        type: 'string',
        enum: [...RESOLUTION_TIERS],
        description: 'Resolution TIER — 480p, 720p, or 1080p. This is not a pixel size; the image tool\'s size parameter is. Omit for the default 720p.',
      },
      model: {
        type: 'string',
        description: 'Provider model id. Omit to let the service route to its default video model.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          media_type: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          path: { type: 'string', required: true },
          seconds: { type: 'string' },
          model: { type: 'string' },
          task_id: { type: 'string' },
        },
      },
      render: (_args, value) => videoContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    timeoutMs: options.timeoutMs,
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')

      const request: ComateVideoRequest = {
        prompt,
        ...(args.seconds === undefined ? {} : { seconds: args.seconds }),
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.model === undefined ? {} : { model: args.model }),
      }
      const deadline = withDeadline(exec.signal, options.timeoutMs)
      const generated = await generate(options.api, request, deadline)

      // Always on disk: see the module note. The attachment store cannot hold a
      // video (audio and video have no dedicated handling there yet), so a
      // file-less video would be a result nobody can open.
      const dir = options.outputDir ?? readSessionCwd(exec.agent, ctx) ?? tmpdir()
      const saved = await saveGeneratedMedia({
        dir,
        bytes: generated.bytes,
        extension: extensionForMediaType(generated.mediaType),
        prefix: 'comate-video',
      })

      publishDeliverables(ctx, exec.agent, exec.callId, [{
        path: saved.path,
        description: `Generated video for: ${prompt.slice(0, 80)}`,
      }])

      return {
        prompt,
        media_type: generated.mediaType,
        bytes: generated.bytes.byteLength,
        path: saved.path,
        ...(generated.seconds === undefined ? {} : { seconds: generated.seconds }),
        ...(generated.model === undefined ? {} : { model: generated.model }),
        ...(generated.taskId === undefined ? {} : { task_id: generated.taskId }),
      }
    },
  }))
}

/**
 * Call the service under the deadline.
 *
 * A caller cancellation keeps its own reason, for the same reason as the image
 * tool: the registry owns that outcome and classifies it as an abort.
 *
 * @param media - the Comate client.
 * @param request - the trimmed prompt plus any caller overrides.
 * @param deadline - the combined caller-plus-clock signal.
 * @returns the generated clip, already downloaded.
 */
async function generate(
  media: ComateMediaApi,
  request: ComateVideoRequest,
  deadline: Deadline,
) {
  return await raceDeadline(
    media.generateVideo(request, deadline.signal),
    deadline,
    (budget) =>
      `video generation did not finish within ${budget} and was cancelled; the upstream queue can be slow at `
      + 'peak times — retry once, or try a shorter clip',
  )
}

/** The validated canonical value {@link videoContent} receives. */
interface VideoOutput {
  prompt: string
  media_type: string
  bytes: number
  path: string
  seconds?: string
  model?: string
  task_id?: string
}

/**
 * Project one generated clip into the model-facing envelope.
 *
 * Text only, deliberately: there is no content block a video can travel in, and
 * pretending otherwise would produce a result the client silently drops. The
 * path is the payload — the model relays it, and the deliverable card is what
 * makes it openable.
 *
 * @param value - the validated canonical value.
 * @returns the content blocks for this result.
 */
function videoContent(value: VideoOutput): ContentBlock[] {
  const lines = [`Generated a video: ${value.media_type}, ${value.bytes} bytes.`]
  lines.push(`Saved to ${value.path}`)
  if (value.seconds !== undefined) lines.push(`Duration: ${value.seconds}s`)
  if (value.model !== undefined) lines.push(`Model: ${value.model}`)
  if (value.task_id !== undefined) lines.push(`Upstream task: ${value.task_id}`)
  return [{ type: 'text', text: lines.join('\n') }]
}
