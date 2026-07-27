import { describe, expect, it } from "vitest";
import updateChannel from "./updateChannel.cjs";

const { installedChannel, normalizeChannelPreference, resolveUpdaterFlags } = updateChannel;

describe("normalizeChannelPreference", () => {
  it("accepts the two known channels", () => {
    expect(normalizeChannelPreference("stable")).toBe("stable");
    expect(normalizeChannelPreference("beta")).toBe("beta");
  });

  it("rejects anything else", () => {
    expect(normalizeChannelPreference(undefined)).toBeNull();
    expect(normalizeChannelPreference(null)).toBeNull();
    expect(normalizeChannelPreference("")).toBeNull();
    expect(normalizeChannelPreference("nightly")).toBeNull();
    expect(normalizeChannelPreference(42)).toBeNull();
  });
});

describe("installedChannel", () => {
  it("reads the channel off the installed version's prerelease tag", () => {
    expect(installedChannel("0.1.17")).toBe("stable");
    expect(installedChannel("0.1.18-beta.7")).toBe("beta");
    expect(installedChannel(undefined)).toBe("stable");
  });
});

describe("resolveUpdaterFlags", () => {
  it("leaves the updater alone when no preference is set", () => {
    expect(resolveUpdaterFlags(undefined)).toBeNull();
    expect(resolveUpdaterFlags(null)).toBeNull();
    expect(resolveUpdaterFlags("bogus")).toBeNull();
  });

  it("opts a stable install into prereleases for the beta channel", () => {
    expect(resolveUpdaterFlags("beta")).toEqual({ allowPrerelease: true, allowDowngrade: false });
  });

  it("lets a beta install downgrade back onto stable", () => {
    expect(resolveUpdaterFlags("stable")).toEqual({ allowPrerelease: false, allowDowngrade: true });
  });
});
