import { describe, expect, it } from "vitest";
import updateChannel from "./updateChannel.cjs";

const { installedChannel, isStalePayload, normalizeChannelPreference, resolveUpdaterFlags } = updateChannel;

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

  it("opts a stable install into prereleases and the beta feed", () => {
    expect(resolveUpdaterFlags("beta")).toEqual({ channel: "beta", allowPrerelease: true, allowDowngrade: false });
  });

  it("points a beta install back at the stable feed and allows the downgrade", () => {
    expect(resolveUpdaterFlags("stable")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: true });
  });
});

describe("isStalePayload", () => {
  it("drops a beta payload once the preference is stable", () => {
    expect(isStalePayload("stable", "0.1.18-beta.7", "0.1.17")).toBe(true);
  });

  it("keeps a stable payload on the stable channel", () => {
    expect(isStalePayload("stable", "0.1.17", "0.1.18-beta.7")).toBe(false);
  });

  it("drops an abandoned stable downgrade after returning to beta", () => {
    expect(isStalePayload("beta", "0.1.17", "0.1.18-beta.7")).toBe(true);
  });

  it("keeps a genuinely newer stable release on the beta channel", () => {
    expect(isStalePayload("beta", "0.1.18", "0.1.18-beta.7")).toBe(false);
    expect(isStalePayload("beta", "0.2.0", "0.1.18-beta.7")).toBe(false);
  });

  it("keeps beta payloads on the beta channel", () => {
    expect(isStalePayload("beta", "0.1.18-beta.8", "0.1.18-beta.7")).toBe(false);
  });

  it("keeps everything when no preference is set", () => {
    expect(isStalePayload(null, "0.1.18-beta.7", "0.1.17")).toBe(false);
    expect(isStalePayload(undefined, "0.1.17", "0.1.18-beta.7")).toBe(false);
  });
});
