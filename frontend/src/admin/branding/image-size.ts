/** A picture's size, by letting the browser decode it (rejects when it isn't an image). */
export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error('not an image'));
      }
    };
    image.onerror = () => {
      reject(new Error('not an image'));
    };
    image.src = src;
  });
}
