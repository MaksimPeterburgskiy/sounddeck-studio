import { describe, expect, it } from "vitest";
import { keyImage, type KeyImageInput } from "./keyImage";

function svg(input: KeyImageInput): string {
  const data = keyImage(input);
  expect(data.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(data.slice(data.indexOf(",") + 1));
}

const voice = { soundId: "horn", startedAt: 10_000, duration: 10, loop: false };

describe("key rendering", () => {
  it("uses a sound color and uppercase initial on a 144px canvas, leaving the title separate", () => {
    const output = svg({ title: "airhorn", color: "#9255aa" });
    expect(output).toContain('width="144" height="144"');
    expect(output).toContain('fill="#9255aa"');
    expect(output).toContain(">A</text>");
    expect(output).not.toContain("airhorn");
    expect(svg({ title: "🔔 Bell" })).toContain(">🔔</text>");
  });

  it("prefers custom embedded images, without permitting external image loads", () => {
    const image = "data:image/png;base64,aGVsbG8=";
    expect(svg({ title: "airhorn", image })).toContain(`<image href="${image}"`);
    expect(svg({ title: "airhorn", image })).not.toContain(">A</text>");
    expect(svg({ title: "airhorn", image: "https://example.com/image.png" })).not.toContain("<image");
    expect(svg({ title: "airhorn", image: "file:///tmp/image.png" })).not.toContain("<image");
  });

  it("escapes user glyphs and rejects colors that could inject SVG markup", () => {
    const output = svg({ title: "<test>", symbol: '<&"', color: 'red"/><script>' });
    expect(output).toContain("&lt;&amp;&quot;");
    expect(output).toContain('fill="#1db7a6"');
    expect(output).not.toContain("<script>");
  });

  it("renders a bright playing border and finite progress using millisecond timestamps and second durations", () => {
    const output = svg({ title: "Horn", playing: voice, now: 15_000 });
    expect(output).toContain('stroke="#62ffe7"');
    expect(output).toContain('width="62" height="6"');
    expect(output).toContain('data-progress="determinate"');
    expect(svg({ title: "Horn", playing: voice, now: 5_000 })).toContain('width="0" height="6"');
    expect(svg({ title: "Horn", playing: voice, now: 30_000 })).toContain('width="124" height="6" rx="3" fill="#62ffe7"');
  });

  it("animates loops as an indeterminate bar, repeating a bounded set of frames", () => {
    const input = { title: "Horn", playing: { ...voice, loop: true } };
    expect(svg({ ...input, now: 10_000 })).toContain('data-progress="indeterminate"');
    expect(keyImage({ ...input, now: 10_000 })).not.toBe(keyImage({ ...input, now: 11_000 }));
    expect(keyImage({ ...input, now: 10_000 })).toBe(keyImage({ ...input, now: 12_000 }));
  });

  it("renders dimmed, warning, and active states distinctly", () => {
    expect(svg({ title: "Horn", dimmed: true, warning: true })).toContain('data-dimmed="true"');
    expect(svg({ title: "Horn", dimmed: true, warning: true })).toContain("⚠</text>");
    expect(svg({ title: "Board", active: true })).toContain('stroke="#1db7a6" stroke-opacity="1" stroke-width="6"');
  });

  it("keeps identical rendered states stable despite timestamp changes", () => {
    expect(keyImage({ title: "Horn", now: 100 })).toBe(keyImage({ title: "Horn", now: 100_000 }));
    expect(keyImage({ title: "Horn", playing: voice, now: 15_000 })).toBe(keyImage({ title: "Horn", playing: voice, now: 15_001 }));
  });
});
