/**
 * The Comate media protocol, as measured against the real gateway.
 *
 * This is the piece the main plugin used to own. It lives here now because the
 * capability belongs to these tools — and because keeping it here means the
 * main plugin can stay released and untouched. The one thing that stayed over
 * there is the credential (see `./credential.ts`), which is the only part this
 * plugin genuinely cannot own.
 *
 * Every body and header below is a shape that was observed to work against
 * `https://comate.wps.cn/llmproxy/v1/user` (see
 * `dsh-connect-comate/scripts/verify-media.mjs` for the live baseline). Where a
 * field is optional in the tool schema, this client still sends the desktop
 * client's own default rather than omitting it: "omit and let the gateway
 * choose" has never been observed, and guessing is how an async submit fails
 * with a message nobody can act on.
 *
 * @module dsh-comate-media/comate/client
 */

import { randomUUID } from 'node:crypto'

import type { ComateCredential } from 'dsh-connect-comate'

import type {
  ComateImageRequest,
  ComateImageResult,
  ComateMediaApi,
  ComateMediaUsage,
  ComateVideoRequest,
  ComateVideoResult,
} from '../contract.ts'
import { sniffImageMediaType, sniffVideoMediaType } from './sniff.ts'

/** Path of the synchronous image endpoint, under the gateway base URL. */
const IMAGES_PATH = '/images/generations'

/** Path of the asynchronous video endpoint. */
const VIDEOS_PATH = '/videos'

/** Header the desktop client sends; the gateway does not require it for auth, but it is part of the observed request. */
const APP_ID = 'comate'

/** How often the asynchronous video task is polled. The desktop client uses five seconds. */
const POLL_INTERVAL_MS = 5_000

/** Total budget for one video task; the desktop client gives up after twenty minutes. */
const VIDEO_BUDGET_MS = 20 * 60 * 1000

/** Desktop defaults, sent when the caller omits the field. */
const DEFAULT_IMAGE_SIZE = '960x960'
const DEFAULT_VIDEO_SIZE = '720p'
const DEFAULT_VIDEO_SECONDS = '5'

/** Video statuses that end the poll loop without a clip. */
const FAILED_VIDEO_STATUSES: readonly string[] = ['failed', 'cancelled', 'expired']

/** Construction inputs. */
export interface ComateMediaClientOptions {
  /**
   * Resolve the credential for ONE call.
   *
   * Called per call rather than once at startup: the user can save a new sid on
   * the main plugin's card between two tool calls, and a credential captured at
   * load time would keep using the old one until the process restarted.
   */
  resolveCredential: () => Promise<ComateCredential>
  /** Poll interval for the asynchronous video task. */
  pollIntervalMs?: number
  /** Total budget for one video task. */
  videoBudgetMs?: number
  /** `fetch` to use; injectable so the protocol can be tested without a network. */
  fetch?: typeof globalThis.fetch
  /** Delay that honours the signal; injectable so tests do not wait five seconds. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * The two media calls, over the Comate gateway.
 *
 * Stateless apart from its options: nothing here caches a credential, a task, or
 * a byte array between calls.
 */
export class ComateMediaClient implements ComateMediaApi {
  private readonly resolveCredential: () => Promise<ComateCredential>
  private readonly pollIntervalMs: number
  private readonly videoBudgetMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>

  /**
   * @param options - credential source, timing, and the test seam.
   */
  constructor(options: ComateMediaClientOptions) {
    this.resolveCredential = options.resolveCredential
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.videoBudgetMs = options.videoBudgetMs ?? VIDEO_BUDGET_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.sleepImpl = options.sleep ?? sleep
  }

  /**
   * Generate one image and return its bytes.
   *
   * The endpoint is synchronous and takes roughly ten seconds against the real
   * gateway. The payload comes back as a URL (not `b64_json`), so a download is
   * part of the normal path rather than a fallback — and the bytes are sniffed
   * because the response header says `application/octet-stream` while the
   * content is JPEG.
   *
   * @param request - prompt plus optional size and model.
   * @param signal - the tool call's signal; cancellation propagates to every hop.
   * @returns the bytes, their sniffed type, and the upstream's own metadata.
   */
  async generateImage(request: ComateImageRequest, signal?: AbortSignal): Promise<ComateImageResult> {
    throwIfAborted(signal)
    const credential = await this.resolveCredential()
    throwIfAborted(signal)

    const payload = await this.requestJson(`${baseOf(credential)}${IMAGES_PATH}`, {
      method: 'POST',
      headers: mediaHeaders(credential),
      body: JSON.stringify({
        prompt: request.prompt,
        n: 1,
        size: request.size ?? DEFAULT_IMAGE_SIZE,
        ...(request.model === undefined ? {} : { model: request.model }),
      }),
    }, signal, 'image generation')

    const item = Array.isArray(payload.data) ? payload.data[0] : undefined
    if (item === null || typeof item !== 'object') {
      throw new Error('image generation returned no image: the response carried no `data` entry')
    }
    const entry = item as { url?: unknown; b64_json?: unknown; revised_prompt?: unknown }

    const bytes = await this.imageBytes(entry, signal)
    const mediaType = sniffImageMediaType(bytes)
    if (mediaType === undefined) {
      throw new Error(
        `image generation returned ${bytes.byteLength} bytes that are not a recognized image format `
        + `(starts with ${hex(bytes.subarray(0, 8))})`,
      )
    }

    const usage = usageOf(payload)
    return {
      bytes,
      mediaType,
      ...(typeof entry.revised_prompt === 'string' && entry.revised_prompt !== ''
        ? { revisedPrompt: entry.revised_prompt }
        : {}),
      ...(typeof payload.model === 'string' && payload.model !== '' ? { model: payload.model } : {}),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * Generate one video and return its bytes.
   *
   * Asynchronous upstream: submit, poll until a terminal status, then fetch the
   * clip's presigned URL and download it. The polling loop checks the signal on
   * every iteration — a signal that is only forwarded to `fetch` leaves a
   * cancelled call sitting in the loop for up to twenty minutes.
   *
   * @param request - prompt plus optional duration, resolution tier, and model.
   * @param signal - the tool call's signal.
   * @returns the bytes, their sniffed type, and the upstream's own metadata.
   */
  async generateVideo(request: ComateVideoRequest, signal?: AbortSignal): Promise<ComateVideoResult> {
    throwIfAborted(signal)
    const credential = await this.resolveCredential()
    throwIfAborted(signal)

    const base = baseOf(credential)
    const headers = mediaHeaders(credential)

    const submitted = await this.requestJson(`${base}${VIDEOS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: request.prompt,
        seconds: request.seconds ?? DEFAULT_VIDEO_SECONDS,
        size: request.size ?? DEFAULT_VIDEO_SIZE,
        ...(request.model === undefined ? {} : { model: request.model }),
      }),
    }, signal, 'video generation')

    const taskId = typeof submitted.id === 'string' && submitted.id !== '' ? submitted.id : undefined
    if (taskId === undefined) {
      throw new Error('video generation was not accepted: the response carried no task id')
    }

    // The task id contains a `/` that belongs to the PATH, not to a segment
    // (`llm-video-doubao-…/<hash>`), so each segment is escaped and the
    // separators are kept — the same spelling the desktop client uses.
    const segment = taskId.split('/').map((part) => encodeURIComponent(part)).join('/')
    const started = Date.now()
    let terminal: Record<string, unknown> | undefined

    for (;;) {
      throwIfAborted(signal)
      const state = await this.requestJson(`${base}${VIDEOS_PATH}/${segment}`, { headers }, signal, 'video generation')
      const status = typeof state.status === 'string' ? state.status : ''

      if (status === 'completed') {
        terminal = state
        break
      }
      if (FAILED_VIDEO_STATUSES.includes(status)) {
        throw new Error(`video generation ${status} upstream${detailOf(state)}`)
      }
      if (Date.now() - started > this.videoBudgetMs) {
        throw new Error(
          `video generation did not finish within ${Math.round(this.videoBudgetMs / 1000)}s `
          + `(last status: ${status || 'unknown'})`,
        )
      }
      await this.sleepImpl(this.pollIntervalMs, signal)
    }

    const content = await this.requestJson(`${base}${VIDEOS_PATH}/${segment}/content`, { headers }, signal, 'video generation')
    const url = typeof content.url === 'string' ? normalizePresignedUrl(content.url) : ''
    if (url === '') {
      throw new Error('video generation finished but returned no download URL')
    }

    const bytes = await this.download(url, signal)
    const mediaType = sniffVideoMediaType(bytes)
    if (mediaType === undefined) {
      throw new Error(
        `video generation returned ${bytes.byteLength} bytes that are not a recognized video format `
        + `(starts with ${hex(bytes.subarray(0, 8))})`,
      )
    }

    const usage = usageOf(terminal)
    return {
      bytes,
      mediaType,
      taskId,
      ...(typeof terminal?.model === 'string' && terminal.model !== '' ? { model: terminal.model } : {}),
      ...(typeof terminal?.seconds === 'string' && terminal.seconds !== '' ? { seconds: terminal.seconds } : {}),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * Read an image payload into bytes.
   *
   * Both spellings are accepted because the endpoint has been seen to use `url`
   * while the OpenAI Images schema also allows `b64_json`; neither is treated as
   * the fallback of the other.
   *
   * @param entry - one element of the response's `data`.
   * @param signal - the tool call's signal.
   * @returns the payload bytes.
   */
  private async imageBytes(
    entry: { url?: unknown; b64_json?: unknown },
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    if (typeof entry.b64_json === 'string' && entry.b64_json !== '') {
      return new Uint8Array(Buffer.from(entry.b64_json, 'base64'))
    }
    if (typeof entry.url === 'string' && entry.url !== '') {
      return await this.download(entry.url, signal)
    }
    throw new Error('image generation returned neither `url` nor `b64_json`')
  }

  /**
   * Fetch one URL as bytes.
   *
   * The presigned URL arrives as `http://`; when that scheme fails the same
   * object is retried over https, mirroring the main plugin's download path.
   * A cancellation is never retried — the user asked for this to stop.
   *
   * @param url - the media URL.
   * @param signal - the tool call's signal.
   * @returns the bytes.
   */
  private async download(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
    try {
      return await this.fetchBytes(url, signal)
    } catch (error) {
      if (!url.startsWith('http://') || signal?.aborted === true) throw error
      return await this.fetchBytes(url.replace(/^http:/, 'https:'), signal)
    }
  }

  /** One download attempt. The URL is deliberately absent from the failure message — it is presigned. */
  private async fetchBytes(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const response = await this.fetchImpl(url, signal === undefined ? {} : { signal })
    if (!response.ok) {
      throw new Error(`could not download the generated media: the presigned URL answered HTTP ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Send one JSON request and return its parsed body.
   *
   * The gateway's media endpoints answer errors as `{ error: { message, type,
   * code } }` with a non-2xx status, so the upstream's own sentence — 「未登录，
   * 请先登录」, 「登录校验失败」, 「所有模型创作图片都失败」 — is what the model
   * gets to relay. Note what is NOT asserted: a `code` field. These endpoints do
   * not send one on success, and a check for `code === 0` would reject every
   * working response.
   *
   * @param url - absolute endpoint URL.
   * @param init - method, headers, body.
   * @param signal - the tool call's signal.
   * @param what - the operation name, for the message.
   * @returns the parsed JSON body.
   */
  private async requestJson(
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: string },
    signal: AbortSignal | undefined,
    what: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
    })

    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const message = upstreamMessage(payload) ?? excerpt(text)
      const hint = response.status === 401
        ? ' The saved wps_sid is missing, expired, or was rejected — ask the user to paste a fresh one on the dsh-connect-comate plugin card.'
        : ''
      throw new Error(`${what} failed: HTTP ${response.status}${message === '' ? '' : ` — ${message}`}.${hint}`)
    }
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`${what} returned a body that is not JSON: ${excerpt(text)}`)
    }
    const record = payload as Record<string, unknown>
    // A 200 carrying an `error` object is possible on this gateway; treat it as
    // the failure it is rather than parsing the rest of the body hopefully.
    if (record.error !== undefined) {
      throw new Error(`${what} failed: ${upstreamMessage(payload) ?? excerpt(text)}`)
    }
    return record
  }
}

/**
 * The gateway usage object, when it really is one.
 *
 * JSON can carry `null` here and the contract declares an object, so the shape
 * is checked at the boundary rather than declared nullable and pushed outward.
 *
 * @param payload - the response body, or undefined when there is none.
 * @returns the usage record, or undefined.
 */
function usageOf(payload: Record<string, unknown> | undefined): ComateMediaUsage | undefined {
  const usage = payload?.['usage']
  return usage !== null && typeof usage === 'object' ? usage as ComateMediaUsage : undefined
}


/**
 * The gateway base URL, without a trailing slash.
 *
 * @param credential - the resolved credential.
 * @returns the base URL.
 */
function baseOf(credential: ComateCredential): string {
  return credential.baseUrl.replace(/\/+$/, '')
}

/**
 * The headers every media request carries.
 *
 * `Cookie` alone authenticates: measured, `Authorization: Bearer <apiKey>`
 * answers `401 not_login` with the same body as sending nothing, while the
 * cookie reaches the business layer. `X-App-Id` is not required either, but the
 * desktop client sends it and it costs nothing to match. The two request ids are
 * for the gateway's own tracing.
 *
 * @param credential - the resolved credential.
 * @returns the header map.
 */
function mediaHeaders(credential: ComateCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-App-Id': APP_ID,
    'X-Request-Id': randomUUID(),
    'X-Session-Id': randomUUID(),
    ...(credential.cookie === undefined ? {} : { Cookie: credential.cookie }),
  }
}

/**
 * Undo the escaping the gateway applies to presigned URLs.
 *
 * The JSON arrives with `\u0026` where the URL needs `&`; fetching it verbatim
 * sends a query string with one giant parameter and the object store answers
 * 403. Both the literal escape and its percent-encoded spelling are seen.
 *
 * @param url - the URL as returned.
 * @returns the URL to fetch.
 */
export function normalizePresignedUrl(url: string): string {
  return url.replace(/\\u0026/gi, '&').replace(/%5Cu0026/gi, '&')
}

/**
 * Pull the upstream's own sentence out of an error body.
 *
 * @param payload - the parsed body, possibly not an object.
 * @returns the message, or `undefined` when the body carries none.
 */
function upstreamMessage(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    const nested = error as Record<string, unknown>
    for (const candidate of [nested.message, nested.msg, nested.code]) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
  }
  for (const candidate of [record.message, record.msg]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * A short, non-JSON body, for a message a model has to read.
 *
 * @param text - the raw body.
 * @returns up to 200 characters.
 */
function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}…`
}

/**
 * A trailing detail for a terminal-but-failed task.
 *
 * @param state - the poll response.
 * @returns ` (message)` or `''`.
 */
function detailOf(state: Record<string, unknown>): string {
  const message = upstreamMessage(state)
  return message === undefined ? '' : ` (${message})`
}

/**
 * Hex of a byte prefix, for a failure message that has to say what arrived.
 *
 * @param bytes - the first bytes of the payload.
 * @returns space-free lowercase hex.
 */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/**
 * Throw the caller's own reason when the signal has already fired.
 *
 * Called at every step of the long path so a cancellation stops the work
 * instead of being noticed only at the next `fetch`.
 *
 * @param signal - the tool call's signal.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error('the tool call was cancelled')
  }
}

/**
 * Sleep that can be cut short.
 *
 * @param ms - milliseconds to wait.
 * @param signal - the tool call's signal.
 * @returns a promise that resolves after the delay or rejects with the signal's reason.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('the tool call was cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
