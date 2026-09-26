/**
 * The contract between this plugin's tools and its Comate client.
 *
 * This used to be a cross-plugin seam: the tools asked the running
 * `dsh-connect-comate` plugin for a `comateMedia` service. It is not one any
 * more, and the reason is worth keeping in writing.
 *
 * DSH has no cross-plugin dependency mechanism. A plugin's manifest may declare
 * `manifestVersion`, `engines.dsh`, `bundle.patch` and `client` — nothing that
 * says "this plugin requires that one" — and the only dependency check the host
 * performs is on `peerDependencies` whose name starts with `@deepseek-ai/dsh`.
 * A service seam therefore cannot be made mandatory: a package can be installed
 * while its loader entry is not mounted, and the consumer simply finds no
 * service. The choice was between a seam that can silently be absent and a hard
 * npm dependency that cannot — and the capability belongs to these tools anyway,
 * so the protocol moved here and `dsh-connect-comate` stayed released.
 *
 * What did NOT move is the credential — see `./comate/credential.ts`.
 *
 * @module dsh-comate-media/contract
 */

/** Image types the sniffer can identify, and therefore the only ones a result can carry. */
export type ComateImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Video types the sniffer can identify. */
export type ComateVideoMediaType = 'video/mp4'

/** Resolution TIERS the video endpoint accepts — not pixel sizes. */
export type ComateVideoSize = '480p' | '720p' | '1080p'

/**
 * The gateway's own accounting for one generation, passed through untouched.
 *
 * Typed loosely on purpose: the image and video endpoints report different key
 * sets (`total_tokens`, `completion_tokens`, `credits`, …), and this plugin
 * renders none of it. It is carried so a caller can log what a generation cost,
 * rather than being dropped between the response and the result.
 */
export type ComateMediaUsage = Readonly<Record<string, unknown>>

/** One image request. */
export interface ComateImageRequest {
  /** What to draw; already trimmed and checked non-empty by the tool. */
  prompt: string
  /** Pixel size as `WIDTHxHEIGHT`. Absent means the client sends the desktop default. */
  size?: string
  /** Provider model id; absent lets the gateway route. */
  model?: string
}

/** One generated image, bytes in hand. */
export interface ComateImageResult {
  /**
   * The image itself — a plain `Uint8Array`, NOT a `Buffer`.
   *
   * Worth spelling out: `Uint8Array.prototype.toString()` ignores its encoding
   * argument and returns comma-joined decimals, so `bytes.toString('latin1')`
   * yields `"255,216,255,…"` rather than text. It does not throw, it just makes
   * every `includes` false. Go through `Buffer.from(bytes)` to read bytes as text.
   */
  bytes: Uint8Array
  /** Sniffed from the bytes, never taken from the response header. */
  mediaType: ComateImageMediaType
  /** The upstream's rewritten prompt, when it sends one. */
  revisedPrompt?: string
  /** The model that actually produced the image, when the gateway names it. */
  model?: string
  /** The gateway's own accounting, when it sends one. */
  usage?: ComateMediaUsage
}

/** One video request. */
export interface ComateVideoRequest {
  /** What to film; already trimmed and checked non-empty by the tool. */
  prompt: string
  /** Duration in seconds as a STRING, because that is what the endpoint takes. */
  seconds?: string
  /** Resolution tier. Absent means the client sends the desktop default. */
  size?: ComateVideoSize
  /** Provider model id; absent lets the gateway route. */
  model?: string
}

/** One generated clip, bytes in hand. */
export interface ComateVideoResult {
  bytes: Uint8Array
  /** Sniffed from the bytes. */
  mediaType: ComateVideoMediaType
  /** The upstream task id, for the audit trail. */
  taskId: string
  /** The duration the gateway reports for the finished clip. */
  seconds?: string
  /** The model that actually produced the clip. */
  model?: string
  /** The gateway's own accounting, when it sends one. */
  usage?: ComateMediaUsage
}

/**
 * The two calls the tools make.
 *
 * `ComateMediaClient` is the shipped implementation; the tests supply their own,
 * which is what keeps the tool suite off the network.
 */
export interface ComateMediaApi {
  /**
   * @param request - prompt plus optional size and model.
   * @param signal - the tool call's signal; cancellation must reach every hop.
   * @returns the image bytes and their sniffed type.
   */
  generateImage(request: ComateImageRequest, signal?: AbortSignal): Promise<ComateImageResult>
  /**
   * @param request - prompt plus optional duration, resolution tier, and model.
   * @param signal - the tool call's signal.
   * @returns the clip bytes and their sniffed type.
   */
  generateVideo(request: ComateVideoRequest, signal?: AbortSignal): Promise<ComateVideoResult>
}
