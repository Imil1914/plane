import { describe, expect, it } from "vitest";
import { presenceCursorColorsForHue } from "@/components/ppm-canvas/board-presence";

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
};
const parseHsl = (value: string) => {
  const m = /hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
  if (!m) throw new Error(`not hsl: ${value}`);
  return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
};
const luminance = ([r, g, b]: [number, number, number]) => {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  // oxlint-disable-next-line unicorn/no-array-sort -- fresh array literal, not a mutation of caller state.
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("presence cursor label", () => {
  it("keeps dark label text readable on every hue", () => {
    for (let hue = 0; hue < 360; hue++) {
      const { label } = presenceCursorColorsForHue(hue);
      expect(contrast(parseHsl(label), [14, 15, 18]), `hue ${hue}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
