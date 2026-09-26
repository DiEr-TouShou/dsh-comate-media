/**
 * `comate_generate_image` — text prompt in, image out.
 *
 * The tool's job is narrow: ask the main plugin for bytes, put them somewhere
 * durable, and hand the model something it can SEE. The last part is the whole
 * reason this tool returns an `ImageBlock` instead of a path: a path makes the
 * model guess, and `dsh-tools` turns a successful image-bearing result into
 * deferred user-message context, so the next step of the turn actually looks at
 * the picture.
 *
 * @module dsh-comate-media/tools/generate-image
 */

import { tmpdir } from 'node:os'

import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { extensionForMediaType } from '../comate/sniff.ts'
import type { ComateImageRequest, ComateMediaApi } from '../contract.ts'
import { publishDeliverables, readSessionCwd } from '../deliverables.ts'
import { raceDeadline, withDeadline } from '../signals.ts'
import type { Deadline } from '../signals.ts'
import { saveGeneratedMedia } from '../storage.ts'

/** The model-facing tool name. */
export const GENERATE_IMAGE_TOOL = 'comate_generate_image'

/** Nested value schema for the committed attachment, mirroring the shape `read_image` declares. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/** Registration inputs the plugin entry owns. */
export interface GenerateImageOptions {
  /** The Comate client; built once by the plugin entry, credential read per call. */
  api: ComateMediaApi
  /** Cooperative budget for one generation, in milliseconds. */
  timeoutMs: number
  /** Whether to keep a copy on disk beside the committed attachment. */
  saveToDisk: boolean
  /** Fixed output directory; when absent the Session working directory is used. */
  outputDir: string | undefined
}

/**
 * Register {@link GENERATE_IMAGE_TOOL}.
 *
 * @param ctx - the plugin context; `tools` is injected, the attachment service
 *   is read lazily per call.
 * @param options - the client, budget, and storage policy from the plugin config.
 */
export function registerGenerateImage(ctx: Context, options: GenerateImageOptions): void {
  ctx.tools.register(defineTool({
    name: GENERATE_IMAGE_TOOL,
    description:
      'Generate an image from a text prompt with the user\'s signed-in WPS Comate account and return the '
      + 'image itself. Use it when the user asks for a picture, illustration, poster, or other artwork. '
      + 'Generation takes roughly ten seconds. The upstream provider applies the required AIGC label, so '
      + 'never add a watermark, caption, or metadata of your own.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw, in the language of the user\'s request. Be specific about subject, style, composition, and lighting.',
      },
      size: {
        type: 'string',
        description: 'Output size in PIXELS as WIDTHxHEIGHT, for example 960x960 or 1024x768. Omit for the default 960x960.',
      },
      model: {
        type: 'string',
        description: 'Provider model id. Omit to let the service route to its default image model.',
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
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          path: { type: 'string' },
          model: { type: 'string' },
          revised_prompt: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageContent(value),
      presentationMeta: (_args, value) => ({ path: value.path ?? null }),
    },
    isConcurrencySafe: () => true,
    timeoutMs: options.timeoutMs,
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')

      const request: ComateImageRequest = {
        prompt,
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.model === undefined ? {} : { model: args.model }),
      }
      const deadline = withDeadline(exec.signal, options.timeoutMs)
      const generated = await generate(options.api, request, deadline)

      const dir = resolveOutputDir(options, exec.agent)
      const saved = dir === undefined
        ? undefined
        : await saveGeneratedMedia({
          dir,
          bytes: generated.bytes,
          extension: extensionForMediaType(generated.mediaType),
          prefix: 'comate-image',
        })

      // Commit through the attachment service so the result carries a durable
      // reference. The reference — not the bytes — is what an `ImageBlock`
      // carries, and it is what lets a resumed session re-read the image.
      const attachments = ctx.get('attachments')
      const ref: ImageAttachmentRef | undefined = attachments === undefined
        ? undefined
        : await attachments.saveImage({
          data: generated.bytes,
          mediaType: generated.mediaType,
          ...(saved === undefined ? {} : { name: basenameOf(saved.path) }),
        })

      if (saved !== undefined) {
        publishDeliverables(ctx, exec.agent, exec.callId, [{
          path: saved.path,
          description: `Generated image for: ${prompt.slice(0, 80)}`,
        }])
      }

      return {
        prompt,
        media_type: generated.mediaType,
        bytes: generated.bytes.byteLength,
        width: ref?.width ?? 0,
        height: ref?.height ?? 0,
        ...(saved === undefined ? {} : { path: saved.path }),
        ...(generated.model === undefined ? {} : { model: generated.model }),
        ...(generated.revisedPrompt === undefined ? {} : { revised_prompt: generated.revisedPrompt }),
        ...(ref === undefined ? {} : {
          image: {
            attachmentId: ref.attachmentId as unknown as string,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          },
        }),
      }
    },
  }))
}

/**
 * Call the service under the deadline.
 *
 * A caller cancellation keeps its own reason: the registry owns that outcome and
 * classifies it as an abort, and rewriting it here would hide the user's own
 * stop button behind an error message.
 *
 * @param media - the Comate client.
 * @param request - the trimmed prompt plus any caller overrides.
 * @param deadline - the combined caller-plus-clock signal.
 * @returns the generated image.
 */
async function generate(
  media: ComateMediaApi,
  request: ComateImageRequest,
  deadline: Deadline,
) {
  return await raceDeadline(
    media.generateImage(request, deadline.signal),
    deadline,
    (budget) =>
      `image generation did not finish within ${budget} and was cancelled; the service may be slow or the `
      + 'account may be rate-limited — retry once, or ask the user to check their WPS Comate account',
  )
}

/**
 * Where a generated image is written, or `undefined` to keep it only in the attachment store.
 *
 * @param options - the plugin config.
 * @param agent - `exec.agent`, possibly absent for nested callers.
 * @returns an absolute directory, or `undefined` when disk copies are off.
 */
function resolveOutputDir(
  options: GenerateImageOptions,
  agent: unknown,
): string | undefined {
  if (!options.saveToDisk) return undefined
  return options.outputDir ?? readSessionCwd(agent) ?? tmpdir()
}

/** Final path segment, without importing `node:path` for one call. */
function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * Project one generated image into the model-facing envelope.
 *
 * The text block leads so a text-only route still learns the dimensions and the
 * saved path; the image block follows, and `dsh-tools` defers it into
 * user-message context so the model can look at what it just made.
 *
 * @param value - the validated canonical value.
 * @returns the content blocks for this result.
 */
function imageContent(value: {
  prompt: string
  media_type: string
  bytes: number
  width: number
  height: number
  path?: string
  model?: string
  revised_prompt?: string
  image?: {
    attachmentId: string
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    bytes: number
    width: number
    height: number
    name?: string
  }
}): ContentBlock[] {
  const lines = [`Generated an image: ${value.width}x${value.height} ${value.media_type}, ${value.bytes} bytes.`]
  if (value.path !== undefined) lines.push(`Saved to ${value.path}`)
  if (value.model !== undefined) lines.push(`Model: ${value.model}`)
  if (value.revised_prompt !== undefined) lines.push(`Upstream prompt: ${value.revised_prompt}`)

  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  if (value.image !== undefined) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(value.image.attachmentId),
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  return blocks
}
