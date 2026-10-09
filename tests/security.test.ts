import { describe, expect, it } from "vitest";
import {
  assertPublicHttpsUrl,
  assertWritableAgentBranch,
  createSessionValue,
  findSecretLikeStrings,
  isStrongAccessToken,
  isTrustedWriteRequest,
  parseAllowedPaths,
  rateLimit,
  redact,
  safeEqual,
  validateRepoPath,
  verifySessionValue,
  DEFAULT_ALLOWED_PATHS,
} from "@/lib/security";

const TOKEN = "x".repeat(40);
const ALLOW = [...DEFAULT_ALLOWED_PATHS];

describe("owner session", () => {
  it("accepts a fresh signed session and rejects tampering and other tokens", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    const value = createSessionValue(TOKEN, now);
    expect(verifySessionValue(TOKEN, value, now + 1000)).toBe(true);
    expect(verifySessionValue(TOKEN, value.replace(/.$/, (c) => (c === "a" ? "b" : "a")), now)).toBe(false);
    expect(verifySessionValue("y".repeat(40), value, now)).toBe(false);
    expect(verifySessionValue(undefined, value, now)).toBe(false);
  });

  it("rejects expired sessions", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    const value = createSessionValue(TOKEN, now);
    expect(verifySessionValue(TOKEN, value, now + 8 * 24 * 3600 * 1000)).toBe(false);
  });

  it("requires a strong access token", () => {
    expect(isStrongAccessToken("short")).toBe(false);
    expect(isStrongAccessToken(TOKEN)).toBe(true);
  });

  it("compares secrets in constant time semantics (boolean result only)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("rate limiting", () => {
  it("blocks after the limit within the window and recovers afterwards", () => {
    const base = 1_000_000;
    expect(rateLimit("k", 2, 1000, base).allowed).toBe(true);
    expect(rateLimit("k", 2, 1000, base + 1).allowed).toBe(true);
    const blocked = rateLimit("k", 2, 1000, base + 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rateLimit("k", 2, 1000, base + 1500).allowed).toBe(true);
  });
});

describe("redaction", () => {
  it("removes well-known credential shapes and exact secret values", () => {
    const githubSecret = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const fineGrainedSecret = "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop";
    const googleSecret = "AIza" + "SyA-1234567890abcdefghijklmnopqrstu";
    const openAiSecret = "sk-" + "abcdefghijklmnopqrstuvwx";
    const fakeHook = "https://api.vercel.com/v1/integrations/deploy/" + "prj_abc/xyz123";
    const text = [
      `token ${githubSecret} and ${fineGrainedSecret}`,
      `google ${googleSecret}`,
      `openai ${openAiSecret}`,
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      `hook ${fakeHook}`,
      "password = hunter2hunter2",
      "custom value-secret-123456 here",
    ].join("\n");
    const cleaned = redact(text, ["value-secret-123456"]);
    expect(cleaned).not.toMatch(/ghp_[A-Za-z0-9]{10}/);
    expect(cleaned).not.toContain("AIza");
    expect(cleaned).not.toContain("hunter2");
    expect(cleaned).not.toContain("value-secret-123456");
    expect(cleaned).not.toContain("integrations/deploy");
    expect(cleaned).toContain("[REDACTED]");
  });

  it("detects secret-like text without returning the value", () => {
    const key = "sk-" + "abcdefghijklmnopqrstuvwx";
    expect(findSecretLikeStrings(`const k = '${key}';`).length).toBeGreaterThan(0);
    expect(findSecretLikeStrings("export const label = 'hello';")).toHaveLength(0);
  });
});

describe("repository path policy", () => {
  it("allows normal source paths and rejects traversal, absolute paths and protected files", () => {
    expect(validateRepoPath("app/page.tsx", ALLOW).ok).toBe(true);
    expect(validateRepoPath("README.md", ALLOW).ok).toBe(true);
    expect(validateRepoPath("../etc/passwd", ALLOW).ok).toBe(false);
    expect(validateRepoPath("app/../../secrets", ALLOW).ok).toBe(false);
    expect(validateRepoPath("/etc/passwd", ALLOW).ok).toBe(false);
    expect(validateRepoPath("C:\\windows", ALLOW).ok).toBe(false);
    expect(validateRepoPath(".github/workflows/x.yml", ALLOW).ok).toBe(false);
    expect(validateRepoPath("app/.env.local", ALLOW).ok).toBe(false);
    expect(validateRepoPath("package-lock.json", ALLOW).ok).toBe(false);
    expect(validateRepoPath("public/model.onnx", ALLOW).ok).toBe(false);
    expect(validateRepoPath("scripts/deploy.sh", ALLOW).ok).toBe(false);
    expect(validateRepoPath("app/a\u0000b.ts", ALLOW).ok).toBe(false);
    expect(validateRepoPath("docs/notes\u202Etsx.md", ALLOW).ok).toBe(false);
  });

  it("reads custom allow-lists from configuration", () => {
    expect(parseAllowedPaths(undefined)).toEqual([...DEFAULT_ALLOWED_PATHS]);
    expect(parseAllowedPaths(" src/ , docs/ ")).toEqual(["src/", "docs/"]);
  });
});

describe("agent branch guard", () => {
  it("writes only to agent/* branches and never to the default branch", () => {
    expect(() => assertWritableAgentBranch("agent/booking-abc123", { defaultBranch: "main", baseBranch: "main" })).not.toThrow();
    expect(() => assertWritableAgentBranch("main", { defaultBranch: "main", baseBranch: "main" })).toThrow();
    expect(() => assertWritableAgentBranch("feature/x", { defaultBranch: "main", baseBranch: "main" })).toThrow();
    expect(() => assertWritableAgentBranch("agent/../main", { defaultBranch: "main", baseBranch: "main" })).toThrow();
    expect(() => assertWritableAgentBranch("agent/main", { defaultBranch: "main", baseBranch: "main" })).not.toThrow();
  });
});

describe("request and URL guards", () => {
  it("requires JSON from the same origin for writes", () => {
    const ok = new Request("https://app.example.com/api/x", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com" },
    });
    const crossSite = new Request("https://app.example.com/api/x", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    const form = new Request("https://app.example.com/api/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const jsonp = new Request("https://app.example.com/api/x", {
      method: "POST",
      headers: { "content-type": "application/jsonp" },
    });
    expect(isTrustedWriteRequest(ok)).toBe(true);
    expect(isTrustedWriteRequest(crossSite)).toBe(false);
    expect(isTrustedWriteRequest(form)).toBe(false);
    expect(isTrustedWriteRequest(jsonp)).toBe(false);
  });

  it("only allows public https URLs for production checks", () => {
    expect(assertPublicHttpsUrl("https://example.com/path").hostname).toBe("example.com");
    expect(() => assertPublicHttpsUrl("http://example.com")).toThrow();
    expect(() => assertPublicHttpsUrl("https://localhost:3000")).toThrow();
    expect(() => assertPublicHttpsUrl("https://localhost./")).toThrow(/Private/);
    expect(() => assertPublicHttpsUrl("https://127.0.0.1")).toThrow(/IP-literal/);
    expect(() => assertPublicHttpsUrl("https://[fe80::1]")).toThrow(/IP-literal/);
    expect(() => assertPublicHttpsUrl("https://example.com:8443")).toThrow(/standard HTTPS port/);
    expect(() => assertPublicHttpsUrl("https://example.com/?token=secret")).toThrow(/query parameters/);
    expect(() => assertPublicHttpsUrl("https://127.0.0.1")).toThrow();
    expect(() => assertPublicHttpsUrl("https://10.0.0.5")).toThrow();
    expect(() => assertPublicHttpsUrl("https://192.168.1.10")).toThrow();
    expect(() => assertPublicHttpsUrl("https://172.20.0.1")).toThrow();
    expect(() => assertPublicHttpsUrl("https://user:pass@example.com")).toThrow();
    expect(() => assertPublicHttpsUrl("not a url")).toThrow();
  });
});
