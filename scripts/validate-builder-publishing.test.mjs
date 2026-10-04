import { describe, expect, it } from "vitest";
import { validateBuilderPublishing } from "./validate-builder-publishing.mjs";

describe("workflow builder publishing guard", () => {
  it.each([
    "pnpm exec electron-builder --win --publish never",
    "pnpm exec electron-builder build -w --publish never",
    "pnpm exec electron-builder \\\n      --win --publish never",
    "electron-builder --publish never && electron-builder build --publish never",
    "# electron-builder --publish always\nrun: electron-builder --publish never",
  ])("accepts explicit publishing suppression in %s", (source) => {
    expect(() => validateBuilderPublishing(source, "test.yml")).not.toThrow();
  });

  it.each([
    "pnpm exec electron-builder \\\n      --publish always",
    "pnpm exec electron-builder -w -p always",
    "pnpm exec electron-builder build --publish always",
    "electron-builder --publish never --publish always",
    "electron-builder --publish never --publish never",
    "electron-builder --publish never -p always",
    "electron-builder --publish never -p=always",
    "electron-builder --publish never -palways",
    "electron-builder --publish never --publish=always",
    "electron-builder --publish never '--publish=always'",
    "electron-builder --publish=never",
    "electron-builder --publish never --publish=never",
    "electron-builder --win # --publish never",
    "electron-builder --publish never && electron-builder -w",
    "electron-builder -w; electron-builder --publish never",
    "electron-builder --publish never\nelectron-builder build --publish always",
    "electron-builder --publish never $(electron-builder --win)",
  ])("rejects missing or conflicting publishing suppression in %s", (source) => {
    expect(() => validateBuilderPublishing(source, "test.yml")).toThrow(/test.yml.*exactly one --publish never/);
  });
});
