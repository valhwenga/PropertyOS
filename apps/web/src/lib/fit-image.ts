/**
 * Making an uploaded logo fit, instead of telling somebody it does not.
 *
 * The product used to refuse a file over 1024 pixels or 512 KB and leave the
 * person to go and shrink it. Nobody has an image editor open when they are
 * setting up a rental business, and a brand asset is the one file they are
 * certain is correct — so the refusal read as the product being fussy about
 * something it could perfectly well do itself.
 *
 * So the browser does it: the picture is drawn into a canvas scaled to fit
 * inside the box, keeping its proportions exactly, and the result is what gets
 * uploaded. The server's own limits stay exactly where they were. They are a
 * backstop against a request that did not come from this form, not a thing a
 * person should have to satisfy by hand.
 *
 * Two rules the arithmetic has to keep:
 *
 *  1. **Never upscale.** A 200px logo stays 200px. Blowing it up to fill the
 *     box would hand somebody a blurred version of their own mark and call it
 *     a conversion.
 *  2. **One scale for both sides.** The whole point of the complaint is that
 *     the proportions must survive, so width and height are multiplied by the
 *     same number and rounded to at least one pixel.
 */

export interface Fitted {
  width: number;
  height: number;
  /** True where the picture was made smaller; false where it was already fine. */
  scaled: boolean;
}

/**
 * The size this picture should be stored at.
 *
 * Pure arithmetic, so it is tested directly rather than through a browser.
 */
export function fitWithin(
  width: number, height: number, longestSide: number,
): Fitted {
  if (width <= 0 || height <= 0) return { width, height, scaled: false };
  const longest = Math.max(width, height);
  if (longest <= longestSide) return { width, height, scaled: false };

  const scale = longestSide / longest;
  return {
    // Math.round, then a floor of 1: a 4000×3 banner must not come back with a
    // height of zero, which no encoder will accept.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

export interface PreparedImage {
  file: File;
  width: number;
  height: number;
  /** What happened, in words, for the person who chose the file. */
  note: string | null;
}

const MAX_SIDE = 1024;
const MAX_BYTES = 512 * 1024;

/**
 * Reads the chosen file and returns one the server will accept.
 *
 * Where the picture already fits, the original file is returned untouched —
 * re-encoding a file that was already correct would change its bytes for no
 * reason, and a landlord who uploads the exact PNG their designer produced
 * should get that PNG.
 *
 * Where it does not fit, it is scaled down and re-encoded. PNG keeps
 * transparency, which a logo usually depends on; a JPEG stays a JPEG, because
 * a photograph re-encoded as PNG grows rather than shrinks. If the result is
 * still over the byte ceiling the picture is stepped down again, which
 * terminates: each pass is 80% of the last.
 *
 * Anything it cannot read — a file the browser refuses to decode — comes back
 * unchanged, and the server says what is wrong with it. The browser is making
 * this easier, not deciding what is allowed.
 */
export async function prepareLogo(file: File): Promise<PreparedImage> {
  const original = { file, width: 0, height: 0, note: null as string | null };
  if (typeof document === 'undefined') return original;

  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = typeof createImageBitmap === 'function'
      ? await createImageBitmap(file)
      : await loadViaElement(file);
  } catch {
    return original; // Not something this browser can draw. Let the server answer.
  }

  const width = 'width' in bitmap ? bitmap.width : 0;
  const height = 'height' in bitmap ? bitmap.height : 0;
  const fitted = fitWithin(width, height, MAX_SIDE);

  if (!fitted.scaled && file.size <= MAX_BYTES) {
    return { file, width, height, note: null };
  }

  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  let target = fitted;
  let quality = 0.92;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const blob = await draw(bitmap, target.width, target.height, type, quality);
    if (!blob) return original;

    if (blob.size <= MAX_BYTES) {
      const renamed = new File([blob], renameFor(file.name, type), { type });
      return {
        file: renamed,
        width: target.width,
        height: target.height,
        note: describe(width, height, target.width, target.height, file.size, blob.size),
      };
    }

    // Too heavy still: a photograph gives it up on quality first, a PNG has
    // none to give, so both end up stepping the size down.
    if (type === 'image/jpeg' && quality > 0.6) {
      quality -= 0.15;
    } else {
      target = fitWithin(target.width, target.height, Math.round(
        Math.max(target.width, target.height) * 0.8,
      ));
    }
  }
  return original;
}

/** Safari before 16.4 and a few embedded views have no createImageBitmap. */
function loadViaElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('undecodable')); };
    image.src = url;
  });
}

function draw(
  source: ImageBitmap | HTMLImageElement, width: number, height: number,
  type: string, quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  // Transparency is preserved by not painting a background: a logo with a
  // transparent surround must not come back on a white rectangle.
  context.imageSmoothingQuality = 'high';
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renameFor(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'logo';
  return `${base}${type === 'image/jpeg' ? '.jpg' : '.png'}`;
}

function describe(
  fromWidth: number, fromHeight: number, toWidth: number, toHeight: number,
  fromBytes: number, toBytes: number,
): string {
  const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
  if (fromWidth === toWidth && fromHeight === toHeight) {
    return `Recompressed from ${kb(fromBytes)} to ${kb(toBytes)}.`;
  }
  return `Resized from ${fromWidth}×${fromHeight} to ${toWidth}×${toHeight} `
    + `(${kb(fromBytes)} → ${kb(toBytes)}), keeping its proportions.`;
}
