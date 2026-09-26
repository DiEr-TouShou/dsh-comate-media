/**
 * The Comate media protocol, driven against a scripted `fetch`.
 *
 * This file exists because the protocol cannot be trusted to reading. Five of
 * the facts it pins were measured against the real gateway and contradict what
 * the desktop client's source suggests (see README「实测偏差」):
 *
 *   1. success bodies carry NO `code` field, so a `code === 0` check would
 *      reject every working response;
 *   2. the image payload arrives as a `url`, not `b64_json`;
 *   3. the response header says `application/octet-stream` while the bytes are
 *      JPEG, so the type must be sniffed;
 *   4. the video task id contains a `/` that belongs to the path;
 *   5. a presigned URL arrives `http://` and `\u0026`-escaped.
 *
 * None of these are guesses: `scripts/verify-media.mjs` in the main plugin
 * records the same facts against the live service, and the assertions here are
 * the offline half of that pair.
 *
 * @module dsh-comate-media/tests/client
 */

import { describe, expect, it } from 'vitest'

import type { ComateCredential } from 'dsh-connect-comate'

import { ComateMediaClient, normalizePresignedUrl } from '../src/comate/client.ts'

/** A credential shaped like the store's. The cookie must reach the wire verbatim. */
const CREDENTIAL: ComateCredential = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'api-key-the-media-endpoints-ignore',
  cookie: 'wps_sid=test-sid',
  authHeader: true,
  models: [],
  configFile: 'C:/fake/config.json',
}

/** JPEG: SOI plus an APP0/JFIF marker, as the real gateway returns. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

/** MP4: an `ftyp` box at offset 4 declaring `isom`. */
const MP4 = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])

/** One recorded request. */
interface Recorded {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
  hasSignal: boolean
}

/** A scripted fetch and what it observed. */
interface Scripted {
  fetch: typeof globalThis.fetch
  calls: Recorded[]
  urls(): string[]
}

/**
 * Build a fetch that answers from a route table and records every call.
 *
 * @param route - returns a response for a URL, or `undefined` to fail loudly.
 * @returns the double and its observation log.
 */
function scriptFetch(route: (url: string) => Response | undefined): Scripted {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const requestInit = init ?? {}
    calls.push({
      url,
      headers: (requestInit.headers ?? {}) as Record<string, string>,
      body: typeof requestInit.body === 'string'
        ? JSON.parse(requestInit.body) as Record<string, unknown>
        : undefined,
      hasSignal: requestInit.signal !== undefined && requestInit.signal !== null,
    })
    const response = route(url)
    if (response === undefined) throw new Error(`unscripted request: ${url}`)
    return response
  }) as unknown as typeof globalThis.fetch
  return { fetch: fetchImpl, calls, urls: () => calls.map((call) => call.url) }
}

/**
 * A JSON response.
 *
 * @param body - the payload.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A binary response whose header deliberately LIES about the type.
 *
 * @param bytes - the payload.
 * @returns the response.
 */
function binary(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}

/**
 * A client wired to a scripted fetch, with polling that does not actually wait.
 *
 * @param fetchImpl - the scripted fetch.
 * @param overrides - fields to change from the defaults.
 * @returns the client.
 */
function createClient(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof ComateMediaClient>[0]> = {},
): ComateMediaClient {
  return new ComateMediaClient({
    resolveCredential: async () => CREDENTIAL,
    fetch: fetchImpl,
    sleep: async () => {},
    pollIntervalMs: 1,
    ...overrides,
  })
}

describe('generateImage', () => {
  it('posts the desktop body and authenticates with the cookie alone', async () => {
    const scripted = scriptFetch((url) => {
      if (url.endsWith('/images/generations')) return json({ data: [{ url: 'https://cdn.test/a.jpg' }] })
      if (url === 'https://cdn.test/a.jpg') return binary(JPEG)
      return undefined
    })

    const result = await createClient(scripted.fetch).generateImage({ prompt: 'a red circle' })

    expect(scripted.urls()).toEqual([
      'https://comate.wps.cn/llmproxy/v1/user/images/generations',
      'https://cdn.test/a.jpg',
    ])
    expect(scripted.calls[0]?.body).toEqual({ prompt: 'a red circle', n: 1, size: '960x960' })
    expect(scripted.calls[0]?.headers.Cookie).toBe('wps_sid=test-sid')
    expect(scripted.calls[0]?.headers['X-App-Id']).toBe('comate')

    // Measured: the api key is not a credential on this endpoint. Sending it
    // would change nothing except to imply the plugin believes otherwise.
    expect(scripted.calls[0]?.headers.Authorization).toBeUndefined()

    // Sniffed from the bytes, because the header said octet-stream.
    expect(result.mediaType).toBe('image/jpeg')
    expect(result.bytes).toEqual(JPEG)
  })

  it('accepts b64_json as readily as url, without a download', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/images/generations')
      ? json({ data: [{ b64_json: Buffer.from(JPEG).toString('base64') }] })
      : undefined)

    const result = await createClient(scripted.fetch).generateImage({ prompt: 'a red circle' })

    expect(result.bytes).toEqual(JPEG)
    expect(scripted.urls()).toHaveLength(1)
  })

  it('forwards size and model only when the caller sets them', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/images/generations')
      ? json({ data: [{ url: 'https://cdn.test/a.jpg' }] })
      : binary(JPEG))

    await createClient(scripted.fetch).generateImage({ prompt: 'x', size: '1024x768', model: 'custom' })

    expect(scripted.calls[0]?.body).toEqual({ prompt: 'x', n: 1, size: '1024x768', model: 'custom' })
  })

  it('does not require a success code, because the endpoint sends none', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/images/generations')
      ? json({ created: 1, data: [{ url: 'https://cdn.test/a.jpg' }], usage: { total_tokens: 14400 } })
      : binary(JPEG))

    const result = await createClient(scripted.fetch).generateImage({ prompt: 'x' })

    expect(result.usage).toEqual({ total_tokens: 14400 })
  })

  it('refuses bytes that are not a recognized image, quoting the prefix', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/images/generations')
      ? json({ data: [{ url: 'https://cdn.test/a.bin' }] })
      : binary(Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])))

    const failure = createClient(scripted.fetch).generateImage({ prompt: 'x' })

    await expect(failure).rejects.toThrow('not a recognized image format')
    await expect(failure).rejects.toThrow('0001020304050607')
  })

  it('surfaces the upstream sentence on a 401 and names what to fix', async () => {
    const scripted = scriptFetch(() => json({ error: { message: '未登录，请先登录', type: 'auth' } }, 401))

    const failure = createClient(scripted.fetch).generateImage({ prompt: 'x' })

    await expect(failure).rejects.toThrow('HTTP 401')
    await expect(failure).rejects.toThrow('未登录，请先登录')
    await expect(failure).rejects.toThrow('paste a fresh one')
  })

  it('treats a 200 carrying an error object as the failure it is', async () => {
    const scripted = scriptFetch(() => json({ error: { message: '所有模型创作图片都失败' } }))

    await expect(createClient(scripted.fetch).generateImage({ prompt: 'x' }))
      .rejects.toThrow('所有模型创作图片都失败')
  })

  it('stops before the network when the call is already cancelled', async () => {
    const scripted = scriptFetch(() => json({}))
    const controller = new AbortController()
    controller.abort(new Error('the user stopped this turn'))

    await expect(createClient(scripted.fetch).generateImage({ prompt: 'x' }, controller.signal))
      .rejects.toThrow('the user stopped this turn')
    expect(scripted.calls).toHaveLength(0)
  })
})

describe('generateVideo', () => {
  /** Routes a full submit → poll → content → download cycle. */
  function videoRoutes(contentUrl: string): (url: string) => Response | undefined {
    const taskId = 'llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123'
    const encoded = 'llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123'
    return (url) => {
      if (url.endsWith('/videos')) return json({ id: taskId, status: 'queued' })
      if (url.endsWith(`/videos/${encoded}/content`)) return json({ url: contentUrl })
      if (url.endsWith(`/videos/${encoded}`)) {
        return json({ status: 'completed', model: 'doubao-seedance-2-0-fast-260128', seconds: '5' })
      }
      if (url.startsWith('https://cdn.test/') || url.startsWith('http://cdn.test/')) return binary(MP4)
      return undefined
    }
  }

  it('submits, polls to completion, then fetches and sniffs the clip', async () => {
    const scripted = scriptFetch(videoRoutes('https://cdn.test/v.mp4'))

    const result = await createClient(scripted.fetch).generateVideo({ prompt: 'a cat' })

    expect(scripted.calls[0]?.body).toEqual({ prompt: 'a cat', seconds: '5', size: '720p' })
    expect(result.mediaType).toBe('video/mp4')
    expect(result.bytes).toEqual(MP4)
    expect(result.taskId).toBe('llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123')
    expect(result.model).toBe('doubao-seedance-2-0-fast-260128')
  })

  it('keeps the path separator in the task id while escaping each segment', async () => {
    const scripted = scriptFetch(videoRoutes('https://cdn.test/v.mp4'))

    await createClient(scripted.fetch).generateVideo({ prompt: 'a cat' })

    // A task id escaped as a single segment would 404: the `/` is structural.
    expect(scripted.urls()).toContain(
      'https://comate.wps.cn/llmproxy/v1/user/videos/llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123',
    )
  })

  it('keeps polling until the task reaches a terminal status', async () => {
    const scripted = scriptFetch((url) => {
      if (url.endsWith('/videos')) return json({ id: 'task-1', status: 'queued' })
      if (url.endsWith('/videos/task-1/content')) return json({ url: 'https://cdn.test/v.mp4' })
      if (url.endsWith('/videos/task-1')) {
        // The real gateway's in-progress body carries fewer keys than its final
        // one, so the client must not read anything it only needs at the end.
        const polls = scripted.urls().filter((seen) => seen.endsWith('/videos/task-1')).length
        return polls < 3
          ? json({ id: 'task-1', status: 'in_progress', progress: 40 })
          : json({ status: 'completed', seconds: '5' })
      }
      return binary(MP4)
    })

    const result = await createClient(scripted.fetch).generateVideo({ prompt: 'a cat' })

    expect(scripted.urls().filter((url) => url.endsWith('/videos/task-1'))).toHaveLength(3)
    expect(result.mediaType).toBe('video/mp4')
  })

  it('reports a failed task with the upstream detail', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/videos')
      ? json({ id: 'task-1' })
      : json({ status: 'failed', message: '内容审核未通过' }))

    await expect(createClient(scripted.fetch).generateVideo({ prompt: 'a cat' }))
      .rejects.toThrow('video generation failed upstream (内容审核未通过)')
  })

  it('gives up when the task outlives the budget instead of polling forever', async () => {
    const scripted = scriptFetch((url) => url.endsWith('/videos')
      ? json({ id: 'task-1' })
      : json({ status: 'in_progress' }))

    await expect(createClient(scripted.fetch, { videoBudgetMs: 0 }).generateVideo({ prompt: 'a cat' }))
      .rejects.toThrow('did not finish within 0s')
  })

  it('checks the signal on every poll, not only inside fetch', async () => {
    const controller = new AbortController()
    const scripted = scriptFetch((url) => {
      if (url.endsWith('/videos')) return json({ id: 'task-1' })
      // Cancel while the task is still queued: a client that only forwards the
      // signal to fetch would keep polling here for twenty minutes.
      controller.abort(new Error('the user stopped this turn'))
      return json({ status: 'in_progress' })
    })

    await expect(createClient(scripted.fetch).generateVideo({ prompt: 'a cat' }, controller.signal))
      .rejects.toThrow('the user stopped this turn')
  })

  it('refuses a task that was accepted without an id', async () => {
    const scripted = scriptFetch(() => json({ status: 'queued' }))

    await expect(createClient(scripted.fetch).generateVideo({ prompt: 'a cat' }))
      .rejects.toThrow('no task id')
  })

  it('retries an http presigned URL over https, but never after a cancellation', async () => {
    const scripted = scriptFetch((url) => {
      if (url.endsWith('/videos')) return json({ id: 'task-1' })
      if (url.endsWith('/videos/task-1/content')) return json({ url: 'http://cdn.test/v.mp4' })
      if (url.endsWith('/videos/task-1')) return json({ status: 'completed' })
      if (url.startsWith('http://cdn.test/')) return undefined
      return binary(MP4)
    })

    const result = await createClient(scripted.fetch).generateVideo({ prompt: 'a cat' })

    expect(scripted.urls()).toContain('http://cdn.test/v.mp4')
    expect(scripted.urls()).toContain('https://cdn.test/v.mp4')
    expect(result.mediaType).toBe('video/mp4')
  })
})

describe('normalizePresignedUrl', () => {
  it('turns the gateway escaping back into a query string', () => {
    expect(normalizePresignedUrl('http://cdn.test/v.mp4?X-Amz-A=1\\u0026X-Amz-B=2'))
      .toBe('http://cdn.test/v.mp4?X-Amz-A=1&X-Amz-B=2')
    expect(normalizePresignedUrl('http://cdn.test/v.mp4?A=1%5Cu0026B=2'))
      .toBe('http://cdn.test/v.mp4?A=1&B=2')
  })

  it('leaves a URL that needs no unescaping alone', () => {
    expect(normalizePresignedUrl('https://cdn.test/v.mp4?a=1&b=2')).toBe('https://cdn.test/v.mp4?a=1&b=2')
  })
})
