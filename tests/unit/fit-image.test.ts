/**
 * Fitting an uploaded logo.
 *
 * The complaint this answers: the product refused anything over 1024 pixels
 * and left the landlord to go and shrink it. The browser now does that, and
 * the arithmetic is here because it is the part that can be wrong in a way
 * nobody notices — a logo squashed by a hair, or a wide banner rounded to a
 * height of zero.
 */
import { describe, it, expect } from 'vitest';
import { fitWithin } from '../../apps/web/src/lib/fit-image';

describe('fitting a picture inside the box', () => {
  it('leaves anything that already fits exactly as it is', () => {
    expect(fitWithin(800, 300, 1024)).toEqual({ width: 800, height: 300, scaled: false });
    // On the limit is inside the limit.
    expect(fitWithin(1024, 1024, 1024)).toEqual({ width: 1024, height: 1024, scaled: false });
  });

  it('never enlarges a small logo to fill the box', () => {
    // Upscaling hands somebody a blurred version of their own mark and calls
    // it a conversion.
    expect(fitWithin(200, 80, 1024)).toEqual({ width: 200, height: 80, scaled: false });
  });

  it('keeps the proportions when it scales down', () => {
    const wide = fitWithin(3000, 1200, 1024);
    expect(wide).toEqual({ width: 1024, height: 410, scaled: true });
    // 3000/1200 = 2.5; 1024/410 = 2.4976 — within half a pixel of the original.
    expect(Math.abs(3000 / 1200 - wide.width / wide.height)).toBeLessThan(0.01);

    const tall = fitWithin(1200, 3000, 1024);
    expect(tall).toEqual({ width: 410, height: 1024, scaled: true });

    const square = fitWithin(4000, 4000, 1024);
    expect(square).toEqual({ width: 1024, height: 1024, scaled: true });
  });

  it('never rounds a side away to nothing', () => {
    // A 4000×3 banner is a real thing somebody will upload once.
    const sliver = fitWithin(4000, 3, 1024);
    expect(sliver.width).toBe(1024);
    expect(sliver.height).toBe(1);
  });

  it('answers for a degenerate size rather than dividing by zero', () => {
    expect(fitWithin(0, 0, 1024)).toEqual({ width: 0, height: 0, scaled: false });
  });
});
