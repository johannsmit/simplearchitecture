import {
  logoMediaTypes,
  maxLogoBytes,
  maxLogoPixels,
  type LogoMediaType,
} from '@simplearchitecture/shared';
import { imageSize } from './image-size';

/** A logo picked in this browser and not saved yet. */
export interface PickedLogo {
  file: Blob;
  type: LogoMediaType;
  name: string;
  size: number;
  width: number;
  height: number;
  /** A `data:` URL of the file, for the tile and the previews (the CSP allows data: images). */
  src: string;
}

/** The words for each refusal (the server's message wins when it sends one). */
export const logoMessages = {
  type: "This file isn't a PNG, JPEG or WebP image. SVG isn't accepted.",
  tooLarge: (bytes: number) =>
    `This file is ${kilobytes(bytes, true)} KB. The largest logo is 300 KB.`,
  tooLargeUnknown: 'This file is larger than 300 KB.',
  pixels: (width: number, height: number) =>
    `This image is ${width} × ${height} px. The largest is ${maxLogoPixels} × ${maxLogoPixels} px.`,
  unreadable: "This file couldn't be read as an image.",
} as const;

/** Whole kilobytes: rounded for display, or up when telling a file is too large. */
export function kilobytes(bytes: number, up = false): number {
  return Math.max(1, up ? Math.ceil(bytes / 1024) : Math.round(bytes / 1024));
}

const isLogoType = (type: string): type is LogoMediaType =>
  (logoMediaTypes as readonly string[]).includes(type);

function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('unreadable'));
    };
    reader.onerror = () => {
      reject(new Error('unreadable'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Checks a picked file in the browser first: its type, size, that it reads as an image,
 * and its dimensions. The server checks again, by the file's own bytes.
 */
export async function checkLogoFile(
  file: File,
): Promise<{ ok: true; logo: PickedLogo } | { ok: false; message: string }> {
  if (!isLogoType(file.type)) return { ok: false, message: logoMessages.type };
  if (file.size > maxLogoBytes) return { ok: false, message: logoMessages.tooLarge(file.size) };
  let src: string;
  let size: { width: number; height: number };
  try {
    src = await dataUrl(file);
    // Only an image data URL of the declared type goes near an <img>.
    if (!src.startsWith(`data:${file.type};base64,`)) throw new Error('unexpected');
    size = await imageSize(src);
  } catch {
    return { ok: false, message: logoMessages.unreadable };
  }
  if (size.width > maxLogoPixels || size.height > maxLogoPixels) {
    return { ok: false, message: logoMessages.pixels(size.width, size.height) };
  }
  return {
    ok: true,
    logo: {
      file,
      type: file.type,
      name: file.name,
      size: file.size,
      width: size.width,
      height: size.height,
      src,
    },
  };
}
