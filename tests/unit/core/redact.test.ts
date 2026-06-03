import { describe, expect, it } from "vitest";
import { redactPaths } from "../../../src/shared/redact.js";

describe("redactPaths", () => {
  it("is a non-empty array of strings", () => {
    expect(Array.isArray(redactPaths)).toBe(true);
    expect(redactPaths.length).toBeGreaterThan(0);
    for (const p of redactPaths) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it("covers password variants", () => {
    const passwordPatterns = redactPaths.filter((p) =>
      p.toLowerCase().includes("password"),
    );
    expect(passwordPatterns.length).toBeGreaterThanOrEqual(5);
  });

  it("covers apiKey variants", () => {
    const apiKeyPatterns = redactPaths.filter(
      (p) =>
        p.toLowerCase().includes("apikey") ||
        p.toLowerCase().includes("api_key"),
    );
    expect(apiKeyPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it("covers masterKey variants", () => {
    const masterKeyPatterns = redactPaths.filter(
      (p) =>
        p.toLowerCase().includes("masterkey") ||
        p.toLowerCase().includes("master_key"),
    );
    expect(masterKeyPatterns.length).toBeGreaterThanOrEqual(2);
  });

  it("covers authorization headers (case-insensitive)", () => {
    const authPatterns = redactPaths.filter((p) =>
      p.toLowerCase().includes("authorization"),
    );
    expect(authPatterns.length).toBeGreaterThanOrEqual(2);
  });

  it("covers token variants", () => {
    const tokenPatterns = redactPaths.filter((p) =>
      p.toLowerCase().includes("token"),
    );
    expect(tokenPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it("includes wildcard patterns for nested fields", () => {
    const wildcardPatterns = redactPaths.filter(
      (p) => p.startsWith("*.") || p.startsWith("*"),
    );
    expect(wildcardPatterns.length).toBeGreaterThan(0);
  });

  it("does not have duplicate entries", () => {
    const unique = new Set(redactPaths);
    expect(unique.size).toBe(redactPaths.length);
  });
});
