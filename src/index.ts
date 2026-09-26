/**
 * `dsh-comate-media` — WPS Comate image and video generation as DSH tools.
 *
 * The plugin owns the two tools, the Comate media protocol, and — through the
 * main plugin's own credential store — the credential. `dsh-connect-comate` is
 * a hard `dependencies` entry, not a service this plugin hopes to find running:
 * DSH has no cross-plugin dependency mechanism, so a service seam could be
 * absent at runtime with nothing to prevent it (see `./contract.ts`).
 *
 * The one design decision worth stating up front: this plugin injects `tools`
 * ONLY, and resolves the credential lazily on every call. Read per call, not
 * captured at load time, so saving a new `wps_sid` on the main plugin's card
 * applies to the next tool call rather than to the next process start.
 * Registration is unconditional, so a call that cannot get a credential fails
 * with a sentence naming the field to fill in — which the model can relay —
 * instead of with a tool that quietly is not there.
 *
 * @module dsh-comate-media
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { ComateMediaClient } from './comate/client.ts'
import { resolveComateCredential } from './comate/credential.ts'
import type { ComateMediaApi } from './contract.ts'
import { registerGenerateImage } from './tools/generate-image.ts'
import { registerGenerateVideo } from './tools/generate-video.ts'

/** Loader identity; matches the package name so the Cordis patch entry resolves. */
export const name = 'dsh-comate-media'

/**
 * Only `tools`.
 *
 * `settings` and `attachments` are intentionally absent — both are read with
 * `ctx.get` at call time. Injecting `settings` would make the whole plugin wait
 * on it, and the credential has an environment fallback that needs no service.
 */
export const inject = ['tools']

/**
 * Plugin configuration.
 *
 * Every value has a working default, so a deployment can mount this plugin with
 * an empty config and get the shipped behavior.
 */
export interface Config {
  /** Fixed directory for generated files. Empty means "the Session working directory, falling back to the system temporary directory". */
  outputDir: string
  /** Budget for one image generation, in milliseconds. */
  imageTimeoutMs: number
  /** Budget for one video generation, in milliseconds. */
  videoTimeoutMs: number
  /** Whether to keep a disk copy of generated IMAGES; videos are always written. */
  saveToDisk: boolean
}

export const Config: z<Config> = z.object({
  /**
   * Fixed directory for generated files. Empty means "the Session working
   * directory, falling back to the system temporary directory".
   */
  outputDir: z.string().default(''),

  /**
   * Budget for one image generation. The shipped desktop client measures about
   * eleven seconds against the real gateway; five minutes leaves room for a
   * cold queue without leaving a stuck call running for an hour.
   */
  imageTimeoutMs: z.number().default(300_000),

  /**
   * Budget for one video generation. Twenty-five minutes, because the shipped
   * client polls the asynchronous task for up to twenty minutes before giving
   * up — a shorter deadline here would abort calls the upstream would have
   * completed.
   */
  videoTimeoutMs: z.number().default(1_500_000),

  /**
   * Whether to keep a disk copy of generated IMAGES beside the committed
   * attachment. Videos are always written to disk, because the file is their
   * only artifact — see `./tools/generate-video.ts`.
   */
  saveToDisk: z.boolean().default(true),
})

/**
 * Register both tools over a given client.
 *
 * Split out of {@link apply} so the tool suite can drive the REAL registration
 * path — Config to options, both tools, both deadlines — with a substitute
 * client. `apply` is then only the shipped composition: build the client, call
 * this.
 *
 * @param ctx - agent-scoped services; `tools` is guaranteed by {@link inject}.
 * @param config - validated plugin configuration.
 * @param api - the Comate client the tools will call.
 */
export function mount(ctx: Context, config: Config, api: ComateMediaApi): void {
  const outputDir = config.outputDir.trim().length === 0 ? undefined : config.outputDir

  registerGenerateImage(ctx, {
    api,
    timeoutMs: config.imageTimeoutMs,
    saveToDisk: config.saveToDisk,
    outputDir,
  })

  registerGenerateVideo(ctx, {
    api,
    timeoutMs: config.videoTimeoutMs,
    outputDir,
  })
}

/**
 * Re-exported for `scripts/verify-live.mjs` and for tests, alongside
 * {@link mount}.
 *
 * These are the two halves of the plugin a script can meaningfully drive
 * without a cordis app and an attachment service: the credential resolution and
 * the wire protocol. The live script uses them to run the REAL client against
 * the REAL gateway — the one thing the offline suite cannot cover.
 */
export { ComateMediaClient } from './comate/client.ts'
export { resolveComateCredential } from './comate/credential.ts'
export type { ResolveComateCredentialOptions } from './comate/credential.ts'
export type {
  ComateImageRequest,
  ComateImageResult,
  ComateMediaApi,
  ComateVideoRequest,
  ComateVideoResult,
} from './contract.ts'

/**
 * Register both tools against the shipped Comate client.
 *
 * @param ctx - agent-scoped services; `tools` is guaranteed by {@link inject}.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // One client for both tools. It holds no credential of its own:
  // `resolveCredential` runs per tool call, so a card save takes effect on the
  // very next call.
  mount(ctx, config, new ComateMediaClient({
    resolveCredential: () => resolveComateCredential(ctx),
  }))
}
