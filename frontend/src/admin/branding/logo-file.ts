import {
  darkLogoTooLargeMessage,
  darkLogoTypeMessage,
  iconMediaType,
  iconPixels,
  iconSizeMessage,
  iconTooLargeMessage,
  iconTypeMessage,
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

/** What a picked image is checked against, and the words for each refusal. */
export interface ImageRules {
  types: readonly LogoMediaType[];
  messages: {
    type: string;
    tooLarge: (bytes: number) => string;
    tooLargeUnknown: string;
    /** Why these dimensions are refused, or null. */
    pixels: (width: number, height: number) => string | null;
    unreadable: string;
  };
}

export const logoRules: ImageRules = {
  types: logoMediaTypes,
  messages: {
    ...logoMessages,
    pixels: (width, height) =>
      width > maxLogoPixels || height > maxLogoPixels ? logoMessages.pixels(width, height) : null,
  },
};

export const darkLogoRules: ImageRules = {
  types: logoMediaTypes,
  messages: {
    type: darkLogoTypeMessage,
    tooLarge: () => darkLogoTooLargeMessage,
    tooLargeUnknown: darkLogoTooLargeMessage,
    pixels: (width, height) =>
      width > maxLogoPixels || height > maxLogoPixels
        ? `The Dark theme logo must be at most ${maxLogoPixels} × ${maxLogoPixels} pixels. This one is ${width} × ${height}.`
        : null,
    unreadable: logoMessages.unreadable,
  },
};

export const iconRules: ImageRules = {
  types: [iconMediaType],
  messages: {
    type: iconTypeMessage,
    tooLarge: () => iconTooLargeMessage,
    tooLargeUnknown: iconTooLargeMessage,
    pixels: (width, height) =>
      width === iconPixels && height === iconPixels ? null : iconSizeMessage(width, height),
    unreadable: logoMessages.unreadable,
  },
};

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
  rules: ImageRules = logoRules,
): Promise<{ ok: true; logo: PickedLogo } | { ok: false; message: string }> {
  const { messages } = rules;
  const type = rules.types.find((each) => each === file.type);
  if (type === undefined) return { ok: false, message: messages.type };
  if (file.size > maxLogoBytes) return { ok: false, message: messages.tooLarge(file.size) };
  let src: string;
  let size: { width: number; height: number };
  try {
    src = await dataUrl(file);
    // Only an image data URL of the declared type goes near an <img>.
    if (!src.startsWith(`data:${file.type};base64,`)) throw new Error('unexpected');
    size = await imageSize(src);
  } catch {
    return { ok: false, message: messages.unreadable };
  }
  const pixels = messages.pixels(size.width, size.height);
  if (pixels !== null) return { ok: false, message: pixels };
  return {
    ok: true,
    logo: {
      file,
      type,
      name: file.name,
      size: file.size,
      width: size.width,
      height: size.height,
      src,
    },
  };
}
