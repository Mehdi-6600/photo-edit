import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type EnvLike = Record<string, string | undefined>;

export const SESSION_COOKIE = "as_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const MIN_ACCESS_TOKEN_LENGTH = 32;

/* ------------------------------------------------------------------ auth */

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function isStrongAccessToken(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= MIN_ACCESS_TOKEN_LENGTH;
}

function sessionKey(accessToken: string): Buffer {
  return createHmac("sha256", accessToken).update("agent-studio-session-key-v1").digest();
}

/** Issues a signed session value of the form `<expiresAt>.<hmac>`. */
export function createSessionValue(accessToken: string, nowMs: number = Date.now()): string {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const signature = createHmac("sha256", sessionKey(accessToken))
    .update(`session|${expiresAt}`)
    .digest("hex");
  return `${expiresAt}.${signature}`;
}

export function verifySessionValue(
  accessToken: string | undefined,
  value: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!isStrongAccessToken(accessToken) || !value) return false;
  const [expRaw, signature, extra] = value.split(".");
  if (!expRaw || !signature || extra !== undefined) return false;
  const expiresAt = Number(expRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return false;
  if (expiresAt > Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS + 60) return false;
  const expected = createHmac("sha256", sessionKey(accessToken))
    .update(`session|${expiresAt}`)
    .digest("hex");
  return safeEqual(expected, signature);
}

/* ------------------------------------------------------- rate limiting */

const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 5000;

/** Sliding-window limiter. Best effort per server instance (serverless instances do not share memory). */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const recent = (buckets.get(key) ?? []).filter((t) => nowMs - t < windowMs);
  if (recent.length >= limit) {
    const retryAfterMs = windowMs - (nowMs - recent[0]);
    buckets.set(key, recent);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(nowMs);
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  buckets.set(key, recent);
  return { allowed: true, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------ redaction */

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\/[^\s"'<>)]+/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|access[_-]?token|secret|password|authorization|token)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

/** Returns how many secret-shaped substrings text contains. Values are never returned, so callers cannot leak them. */
export function findSecretLikeStrings(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) hits.push(...matches.map(() => "match"));
  }
  return hits;
}

/** Removes credentials that match well-known shapes, plus any exact secret values supplied by the caller. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let output = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) output = output.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => {
      if (typeof prefix === "string" && prefix.length > 0 && match.startsWith(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return output;
}

/* ------------------------------------------------------- path policy */

export interface PathPolicy {
  allow: readonly string[];
  maxFiles: number;
  maxBytesPerFile: number;
}

export const DEFAULT_ALLOWED_PATHS = [
  "app/",
  "components/",
  "lib/",
  "src/",
  "tests/",
  "test/",
  "docs/",
  "public/",
  "agent-studio/",
  "README.md",
] as const;

const DENY_PATTERNS: RegExp[] = [
  /^\.github\//i,
  /^\.git\//i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)node_modules\//,
  /(^|\/)\.vercel\//,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /\.(onnx|pem|key|p12|pfx|der|sqlite|sqlite3|db|exe|dll|so|dylib|wasm)$/i,
  /(^|\/)secrets?(\/|\.|$)/i,
];

export function parseAllowedPaths(raw: string | undefined): string[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_PATHS];
}

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** True when text contains ASCII control characters (U+0000 to U+001F or U+007F). */
export function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Replaces ASCII control characters with spaces. */
export function stripControlChars(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output += code < 32 || code === 127 ? " " : text[index];
  }
  return output;
}

/** Validates a repository-relative path produced by a model or user. Rejects traversal, absolute paths and denied files. */
export function validateRepoPath(rawPath: string, allow: readonly string[]): PathCheck {
  if (typeof rawPath !== "string") return { ok: false, reason: "Path must be a string." };
  const path = rawPath.trim();
  if (path.length === 0 || path.length > 200) return { ok: false, reason: "Path length is out of range." };
  if (path.includes("\\") || hasControlChars(path)) return { ok: false, reason: "Path contains forbidden characters." };
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return { ok: false, reason: "Absolute paths are not allowed." };
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, reason: "Path traversal or empty segments are not allowed." };
  }
  if (DENY_PATTERNS.some((pattern) => pattern.test(path))) {
    return { ok: false, reason: `Path is protected: ${path}` };
  }
  const allowed = allow.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));
  if (!allowed) return { ok: false, reason: `Path is outside the allowed areas: ${path}` };
  return { ok: true, path };
}

/* ------------------------------------------------------ branch guard */

const AGENT_BRANCH = /^agent\/[a-z0-9][a-z0-9._-]{2,80}(\/[a-z0-9][a-z0-9._-]{1,60})?$/;

export function isAgentBranchName(name: string): boolean {
  return AGENT_BRANCH.test(name) && !name.includes("..");
}

/** Agents may only write to dedicated agent/* branches, never to the default or base branch. */
export function assertWritableAgentBranch(
  name: string,
  guards: { defaultBranch?: string; baseBranch?: string },
): void {
  if (!isAgentBranchName(name)) {
    throw new Error(`Refusing to write to "${name}". Agent branches must match agent/<name>.`);
  }
  if (name === guards.defaultBranch || name === guards.baseBranch || name === "main" || name === "master") {
    throw new Error(`Refusing to write to protected branch "${name}".`);
  }
}

/* ---------------------------------------------------- request guards */

/** Public host the browser used: the first forwarded host (behind a proxy) or the Host header. */
export function publicHost(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const host = request.headers.get("host")?.trim();
  if (host) return host;
  try {
    return new URL(request.url).host;
  } catch {
    return null;
  }
}

/** True when the browser reached the app over https (directly or via a proxy). */
export function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto) return forwardedProto === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Blocks cross-site form posts: mutating requests must be JSON and, if an Origin header is present, same-origin. */
export function isTrustedWriteRequest(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = publicHost(request);
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "local";
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|\[?fc|\[?fd|.*\.local$|.*\.internal$)/i;
const PRIVATE_172 = /^172\.(1[6-9]|2\d|3[01])\./;

/** Only public https URLs may be fetched from the server (used for production verification). */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The URL is not valid.");
  }
  if (url.protocol !== "https:") throw new Error("Only https URLs can be checked.");
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  if (PRIVATE_HOST.test(url.hostname) || PRIVATE_172.test(url.hostname)) {
    throw new Error("Private or local addresses cannot be checked.");
  }
  return url;
}

export function maskTail(value: string | undefined, visible = 4): string {
  if (!value) return "";
  return value.length <= visible ? "••••" : `••••${value.slice(-visible)}`;
}
