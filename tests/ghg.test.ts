import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  loadConfigRoot,
  parseGithubOwnerRepo
} from "../src/ghg";

describe("parseGithubOwnerRepo", () => {
  it("parses git@github.com remotes", () => {
    expect(parseGithubOwnerRepo("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo"
    });
  });

  it("parses https remotes", () => {
    expect(parseGithubOwnerRepo("https://github.com/foo/bar")).toEqual({
      owner: "foo",
      name: "bar"
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGithubOwnerRepo("git@gitlab.com:foo/bar.git")).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats minutes", () => {
    expect(formatRelativeTime("2024-12-31T23:58:00Z")).toBe("2 min ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime("2024-12-31T22:00:00Z")).toBe("2 hr ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime("2024-12-30T00:00:00Z")).toBe("2 days ago");
  });

  it("handles missing values", () => {
    expect(formatRelativeTime(null)).toBe("-");
  });
});

describe("loadConfigRoot", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("reads root from config file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghg-"));
    const configDir = path.join(tempDir, ".config", "ghg");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ root: "/tmp/work" }),
      "utf8"
    );
    process.env.HOME = tempDir;
    expect(loadConfigRoot()).toBe("/tmp/work");
  });
});
