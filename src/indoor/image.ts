import sharp from 'sharp';
import { AppError } from '../errors.js';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** Detects type from magic bytes. The client-declared MIME type is never trusted. */
export function sniffImage(buf: Buffer): ImageMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export interface NormalizedImage {
  data: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

export interface ImageLimits {
  maxBytes: number;
  /** Maximum width or height of the input in pixels. */
  maxDimension: number;
}

const bad = (m: string, status = 400) => new AppError('validation_error', status, m);

/**
 * Validates and re-encodes an upload. Re-encoding through sharp drops all metadata (EXIF incl. GPS, XMP, ICC),
 * applies the EXIF orientation first, and bounds the output size. Input pixels are capped to prevent decompression bombs.
 */
export async function normalizeImage(
  input: Buffer,
  declaredMime: string | undefined,
  limits: ImageLimits,
): Promise<NormalizedImage> {
  if (input.length === 0) throw bad('The image is empty.');
  if (input.length > limits.maxBytes)
    throw new AppError(
      'payload_too_large',
      413,
      `The image is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`,
    );
  const sniffed = sniffImage(input);
  if (!sniffed)
    throw new AppError('unsupported_media_type', 415, 'Only JPEG, PNG and WebP images are accepted.');
  if (declaredMime && !['image/jpeg', 'image/png', 'image/webp'].includes(declaredMime)) {
    throw new AppError('unsupported_media_type', 415, 'Only JPEG, PNG and WebP images are accepted.');
  }
  if (declaredMime && declaredMime !== sniffed)
    throw bad('The image content does not match its declared type.');

  try {
    const meta = await sharp(input, {
      limitInputPixels: limits.maxDimension * limits.maxDimension,
      failOn: 'error',
    }).metadata();
    if (!meta.width || !meta.height) throw bad('The image could not be read.');
    if (meta.width > limits.maxDimension || meta.height > limits.maxDimension) {
      throw bad(`The image is larger than ${limits.maxDimension}px on one side.`);
    }
    const { data, info } = await sharp(input, {
      limitInputPixels: limits.maxDimension * limits.maxDimension,
      failOn: 'error',
    })
      .rotate() // apply EXIF orientation, then metadata is dropped on output
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, mimeType: 'image/jpeg', width: info.width, height: info.height };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad('The image could not be processed.');
  }
}
