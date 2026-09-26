/**
 * What the bytes ARE, as opposed to what a response header claimed.
 *
 * This module exists because of one measured fact: the gateway's image response
 * carries `content-type: application/octet-stream` while the bytes are JPEG
 * (`FF D8 FF E0 … JFIF`). Trusting the header produces a `.png` file whose
 * signature check fails later, at the far end of a chain where the cause is no
 * longer visible. So every payload is identified by its leading bytes.
 *
 * @module dsh-comate-media/comate/sniff
 */

import type { ComateImageMediaType, ComateVideoMediaType } from '../contract.ts'

/**
 * Read `length` bytes at `offset` as ASCII, or `''` when the buffer is shorter.
 *
 * @param bytes - the payload.
 * @param offset - start offset.
 * @param length - number of bytes to read.
 * @returns the ASCII slice, empty when out of range.
 */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return bytes.byteLength < offset + length
    ? ''
    : String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/** Whether `bytes` starts with the given signature. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.byteLength >= signature.length
    && signature.every((value, index) => bytes[index] === value)
}

/**
 * Identify an image payload by its signature.
 *
 * @param bytes - the downloaded payload.
 * @returns the sniffed media type, or `undefined` when it is not a known image.
 */
export function sniffImageMediaType(bytes: Uint8Array): ComateImageMediaType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 0, 3) === 'GIF') return 'image/gif'
  return undefined
}

/**
 * Identify a video payload by its signature.
 *
 * MP4 carries the `ftyp` box at offset 4, after the box length.
 *
 * @param bytes - the downloaded payload.
 * @returns `video/mp4`, or `undefined` when the bytes are something else.
 */
export function sniffVideoMediaType(bytes: Uint8Array): ComateVideoMediaType | undefined {
  return ascii(bytes, 4, 4) === 'ftyp' ? 'video/mp4' : undefined
}

/**
 * The file extension for a media type, including the dot.
 *
 * Falls back to `.bin` rather than guessing: an unknown type reaching this
 * function means the sniffers disagreed with the caller, and a wrong extension
 * is worse than an honest one.
 *
 * @param mediaType - a media type this plugin produced.
 * @returns the extension.
 */
export function extensionForMediaType(mediaType: string): string {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/png') return '.png'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  if (mediaType === 'video/mp4') return '.mp4'
  return '.bin'
}
