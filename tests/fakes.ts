/**
 * Test doubles for the two collaborators this plugin reads.
 *
 * Deliberately hand-written rather than mocked by a framework: what these tests
 * need to prove is the CONTRACT the plugin depends on — the exact fields it
 * reads off an attachment reference, and the exact shape it expects back from
 * its Comate client. A structural double makes any drift a compile error at the
 * boundary, which a `vi.mock` of the real module would not.
 *
 * Note what is NOT doubled: the Comate protocol itself. `tests/client.spec.ts`
 * drives the real `ComateMediaClient` against a scripted `fetch`, so the
 * sniffing, the URL handling, and the polling loop are tested rather than
 * assumed.
 *
 * @module dsh-comate-media/tests/fakes
 */

import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

import type {
  ComateImageRequest,
  ComateImageResult,
  ComateMediaApi,
  ComateVideoRequest,
  ComateVideoResult,
} from '../src/contract.ts'

/** A real 1x1 PNG, so written bytes are a real image rather than filler. */
export const ONE_PIXEL_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** One recorded `saveImage` call. */
export interface RecordedImageSave {
  data: Uint8Array
  mediaType: string
  name?: string
}

/** The fake attachment service plus what it observed. */
export interface FakeAttachments {
  /** The double to mount as `attachments`. */
  service: AttachmentStore
  /** Every `saveImage` call, in order. */
  saves: RecordedImageSave[]
  /** Fixed intrinsic size the fake reports, standing in for a real decode. */
  dimensions: { width: number; height: number }
}

/**
 * Build an attachment store that records instead of persisting.
 *
 * @param dimensions - the size to report for every committed image.
 * @returns the double and its observation log.
 */
export function createFakeAttachments(dimensions = { width: 960, height: 960 }): FakeAttachments {
  const saves: RecordedImageSave[] = []
  const service = {
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      saves.push({
        data: input.data,
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      return {
        attachmentId: `fake-attachment-${saves.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: dimensions.width,
        height: dimensions.height,
        ...(input.name === undefined ? {} : { name: input.name }),
      } as unknown as ImageAttachmentRef
    },
  } as unknown as AttachmentStore
  return { service, saves, dimensions }
}

/**
 * How one fake generation call ended.
 *
 * `hang` never settles AND never observes the signal — the worst case a caller
 * must survive, so the deadline tests exercise the plugin's own cancellation
 * rather than the double's cooperation. `cancel` is the well-behaved opposite:
 * it rejects with whatever reason the caller's signal carries, which is what a
 * real downstream does when the user presses stop.
 */
export type FakeMediaBehavior = 'ok' | 'hang' | 'fail' | 'cancel'

/** The fake Comate client plus what it observed. */
export interface FakeMedia {
  /** The double to pass to the plugin's mount step. */
  service: ComateMediaApi
  /** Every image request, in order. */
  imageRequests: ComateImageRequest[]
  /** Every video request, in order. */
  videoRequests: ComateVideoRequest[]
  /** The signal handed to the most recent call, for cancellation assertions. */
  lastSignal(): AbortSignal | undefined
}

/** Options for {@link createFakeMedia}. */
export interface FakeMediaOptions {
  /** How image calls behave. Defaults to `ok`. */
  image?: FakeMediaBehavior
  /** How video calls behave. Defaults to `ok`. */
  video?: FakeMediaBehavior
  /** Image bytes to return. Defaults to {@link ONE_PIXEL_PNG}. */
  imageBytes?: Uint8Array
  /** Video bytes to return. Defaults to a four-byte stand-in. */
  videoBytes?: Uint8Array
}

/**
 * Build a Comate client whose latency and failure mode each test can choose.
 *
 * The `ok` image result reports `image/jpeg` for PNG bytes on purpose: the real
 * gateway answers `application/octet-stream` while returning JPEG, and this
 * plugin must pass the SNIFFED type through rather than the header's.
 *
 * @param options - per-modality behavior.
 * @returns the double and its observation log.
 */
export function createFakeMedia(options: FakeMediaOptions = {}): FakeMedia {
  const imageRequests: ComateImageRequest[] = []
  const videoRequests: ComateVideoRequest[] = []
  let last: AbortSignal | undefined

  const imageBehavior = options.image ?? 'ok'
  const videoBehavior = options.video ?? 'ok'
  const imageBytes = options.imageBytes ?? ONE_PIXEL_PNG
  const videoBytes = options.videoBytes ?? Uint8Array.from([0, 0, 0, 0x18])

  const service = {
    async generateImage(request: ComateImageRequest, signal?: AbortSignal): Promise<ComateImageResult> {
      imageRequests.push(request)
      last = signal
      if (imageBehavior === 'hang') return new Promise<never>(() => {})
      if (imageBehavior === 'cancel') return await rejectOnAbort(signal)
      if (imageBehavior === 'fail') throw new Error('upstream refused: not signed in')
      return {
        bytes: imageBytes,
        mediaType: 'image/jpeg',
        revisedPrompt: 'a red circle on white, centered',
        model: 'fake-image-model',
      }
    },
    async generateVideo(request: ComateVideoRequest, signal?: AbortSignal): Promise<ComateVideoResult> {
      videoRequests.push(request)
      last = signal
      if (videoBehavior === 'hang') return new Promise<never>(() => {})
      if (videoBehavior === 'cancel') return await rejectOnAbort(signal)
      if (videoBehavior === 'fail') throw new Error('upstream refused: not signed in')
      return {
        bytes: videoBytes,
        mediaType: 'video/mp4',
        model: 'doubao-seedance-2-0-fast-260128',
        taskId: 'llm-video-doubao-doubao-seedance-2-0-fast-260128/abc123',
        seconds: '5',
      }
    },
  } as unknown as ComateMediaApi

  return { service, imageRequests, videoRequests, lastSignal: () => last }
}

/**
 * A promise that rejects with the caller's own reason, whenever they cancel.
 *
 * @param signal - the signal the call was given.
 * @returns a promise that never resolves.
 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return new Promise<never>(() => {})
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason ?? new Error('the tool call was cancelled'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

/** A Session stand-in that records appended events. */
export interface FakeSession {
  header: { cwd?: string }
  /** Every appended `(event, payload)` pair. */
  events: { event: string; payload: unknown }[]
  append(event: string, payload: unknown): void
}

/**
 * Build a Session double that records the deliverable event.
 *
 * @param cwd - the working directory to report, or `undefined` for none.
 * @returns the double and its event log.
 */
export function createFakeSession(cwd?: string): FakeSession {
  const events: { event: string; payload: unknown }[] = []
  return {
    header: cwd === undefined ? {} : { cwd },
    events,
    append(event, payload) {
      events.push({ event, payload })
    },
  }
}
