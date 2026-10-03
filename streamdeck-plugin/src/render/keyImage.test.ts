import { describe, expect, it } from "vitest";
import { keyTitle } from "./keyTitle";
import { keyImage, type KeyImageInput } from "./keyImage";
const svg = (input: KeyImageInput) => decodeURIComponent(keyImage(input).split(",")[1]);
const voice = { soundId: "horn", startedAt: 10_000, duration: 10, loop: false };

describe("key rendering", () => {
  it("keeps status labels and long library titles within two lines", () => {
    expect(keyTitle("Enable\nin app")).toBe("Enable\nin app");
    expect(keyTitle("Distant thunderstorm rolling overhead")).toBe("Distant\nthunder…");
    expect(keyTitle("Main board")).toBe("Main\nboard");
  });
  it("uses explicit glyphs independently of titles and escapes untrusted input", () => {
    expect(svg({ title: "Offline", glyph: "A" })).toContain(">A</text>");
    expect(svg({ title: "Offline" })).not.toContain(">O</text>");
    const output = svg({ title: "<test>", glyph: "<", color: 'red"/><script>' });
    expect(output).toContain("&lt;</text>");
    expect(output).not.toContain("<script>");
    expect(output).toContain('data-pad="sound"');
  });
  it("prefers embedded custom images with both SVG link attributes, rejecting external loads", () => {
    const image = "data:image/png;base64,aGVsbG8=";
    const output = svg({ title: "airhorn", glyph: "A", image });
    expect(output).toContain('data-image="custom"');
    expect(output).toContain(`xlink:href="${image}"`);
    expect(output).not.toContain('data-glyph="initial"');
    for (const image of ["https://example.com/image.png", "file:///tmp/image.png"]) {
      expect(svg({ title: "airhorn", image })).not.toContain('data-image="custom"');
    }
    expect(output).not.toMatch(/dominant-baseline|clipPath/);
  });
  it("renders finite progress in the top strip, clamping time before and after playback", () => {
    const input = { title: "Horn", playing: voice };
    expect(svg({ ...input, now: 15_000 })).toContain('data-ring="playing"');
    expect(svg({ ...input, now: 15_000 })).toContain('data-progress-track="top"');
    expect(svg({ ...input, now: 15_000 })).toContain('data-progress-pixels="56"');
    expect(svg({ ...input, now: 5_000 })).toContain('data-progress-pixels="0"');
    expect(svg({ ...input, now: 30_000 })).toContain('data-progress-pixels="112"');
  });
  it("animates loops with a bounded repeating set of frames", () => {
    const input = { title: "Horn", playing: { ...voice, loop: true } };
    expect(svg({ ...input, now: 10_000 })).toContain('data-progress="indeterminate"');
    expect(keyImage({ ...input, now: 10_000 })).not.toBe(keyImage({ ...input, now: 11_000 }));
    expect(keyImage({ ...input, now: 10_000 })).toBe(keyImage({ ...input, now: 12_000 }));
  });
  it("keeps rings on a dark margin and draws warning paths after dimming without a competing glyph", () => {
    for (const color of ["#1db7a6", "#62ffe7", "#ffff00"]) {
      expect(svg({ title: "Board", color, active: true })).toContain('data-ring="active"');
    }
    const output = svg({ title: "Missing", glyph: "M", warning: true, dimmed: true });
    expect(output).toContain('data-warning="true"');
    expect(output.indexOf('data-warning=')).toBeGreaterThan(output.indexOf('data-dimmed='));
    expect(output).not.toContain(">M</text>");
    expect(output).not.toContain("⚠");
    expect(svg({ title: "Stop all", icon: "stop-all", playingRing: true })).toContain('data-icon="stop-all"');
    expect(svg({ title: "Mic", icon: "toggle-on", active: true })).toContain('data-pad="control"');
  });
  it("fits artwork above the title, shrinking it for two-line titles", () => {
    const artwork = (title: string) => {
      const match = svg({ title, icon: "cycle-boards" }).match(/data-icon="cycle-boards" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/)!;
      const [x, y, scale] = match.slice(1).map(Number);
      return { centerX: x + 12 * scale, bottom: y + 24 * scale, scale };
    };
    const one = artwork("Stop all"), two = artwork("Main Board");
    expect(one.centerX).toBe(72);
    expect(two.centerX).toBe(72);
    expect(two.scale).toBeLessThan(one.scale);
    expect(one.bottom).toBeLessThanOrEqual(144 - 8 - 30);
    expect(two.bottom).toBeLessThanOrEqual(144 - 8 - 60);
  });
  it("keeps identical rendered states stable despite timestamp changes", () => {
    expect(keyImage({ title: "Horn", now: 100 })).toBe(keyImage({ title: "Bell", now: 100_000 }));
    expect(keyImage({ title: "Horn", playing: voice, now: 15_000 })).toBe(keyImage({ title: "Horn", playing: voice, now: 15_001 }));
  });
});
