import { type EnvLike, redact, stripControlChars } from "./security";

/**
 * Minimal client for any OpenAI-compatible Chat Completions endpoint. This covers
 * free tiers such as Google AI Studio (Gemini), OpenRouter `:free` models, Groq,
 * and local servers such as Ollama. The app sends no image uploads or credentials,
 * but it may send the owner's project brief, allow-listed repository snippets, and
 * sanitized CI/review output. Redaction is best-effort; use providers whose data terms
 * are acceptable for the code and project details being sent.
 */

export interface ModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Per-call retry cap for interactive diagnostics; normal tasks use bounded retries. */
  maxAttempts?: number;
}

export interface ChatResult {
  text: string;
  model: string;
}

export interface ChatPort {
  readonly model: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

export class ModelError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    this.status = status;
  }
}

export function modelConfigFromEnv(env: EnvLike = process.env): ModelConfig | null {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("LLM_BASE_URL is not a valid URL.");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LLM_BASE_URL must not contain embedded credentials, query parameters or fragments.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("LLM_BASE_URL must use https (http is allowed only for localhost development).");
  }
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    apiKey: env.LLM_API_KEY?.trim() || undefined,
    model,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5000 ? Math.min(timeout, 120000) : 45000,
  };
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ModelClient implements ChatPort {
  private readonly config: ModelConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: ModelConfig,
    options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleepDefault;
  }

  get model(): string {
    return this.config.model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2000,
      stream: false,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const secrets = this.config.apiKey ? [this.config.apiKey] : [];
    const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts ?? 3)));

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (error) {
        if (attempt < maxAttempts) {
          await this.sleep(1500 * attempt);
          continue;
        }
        const reason = error instanceof Error ? error.message : "network error";
        throw new ModelError(`The model endpoint could not be reached: ${redact(reason, secrets)}`);
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : 2000 * attempt;
        await this.sleep(waitMs);
        continue;
      }

      const data = (await response.json().catch(() => null)) as
        | { choices?: { message?: { content?: unknown } }[]; model?: unknown; error?: { message?: string } }
        | null;

      if (!response.ok) {
        const detail = data?.error?.message ?? response.statusText;
        throw new ModelError(
          `The model returned HTTP ${response.status}: ${redact(String(detail), secrets)}`,
          response.status,
        );
      }

      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new ModelError("The model returned an empty response.");
      }
      return { text, model: typeof data?.model === "string" ? data.model : this.config.model };
    }
  }
}

/* --------------------------------------------- connectivity check */

export interface ConnectivityCheckResult {
  /** True when the endpoint answered; false when the probe itself failed. */
  ok: boolean;
  /** True when the model answered the explicit probe with the expected reply. */
  replyAccepted: boolean;
  /** Configured model name, redacted and control-stripped. Never raw provider output. */
  model: string | null;
  elapsedMs: number;
  /** Upstream HTTP status when known; callers map failures to 502. */
  status?: number;
  /** Redacted failure description. Present only when ok is false. */
  error?: string;
}

/** The probe asks for exactly "OK"; punctuation-tolerant but nothing else is accepted. */
export function isConnectivityReply(text: string): boolean {
  return /^ok[.!]?$/i.test(text.trim());
}

/**
 * Runs one short, explicit connectivity probe against a configured model endpoint.
 * Never throws and never returns raw model output: only the redacted model name,
 * latency, and an accept/reject flag. Errors are redacted against known secrets.
 */
export async function runConnectivityCheck(
  model: ChatPort,
  options: { secrets?: readonly string[]; now?: () => Date } = {},
): Promise<ConnectivityCheckResult> {
  const secrets = options.secrets ?? [];
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  try {
    const response = await model.chat(
      [
        { role: "system", content: "This is a connectivity check. Reply with exactly the two letters OK and nothing else." },
        { role: "user", content: "Reply OK." },
      ],
      { maxTokens: 8, temperature: 0, maxAttempts: 1 },
    );
    return {
      ok: true,
      replyAccepted: isConnectivityReply(response.text),
      model: stripControlChars(redact(response.model, secrets)).slice(0, 120),
      elapsedMs: Math.max(0, now().getTime() - startedAt),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model endpoint could not be reached.";
    return {
      ok: false,
      replyAccepted: false,
      model: stripControlChars(redact(model.model, secrets)).slice(0, 120),
      elapsedMs: Math.max(0, now().getTime() - startedAt),
      status: error instanceof ModelError ? error.status : undefined,
      error: stripControlChars(redact(message, secrets)).slice(0, 300),
    };
  }
}

/** Finds the first balanced JSON object in model output, tolerating prose and code fences. */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const slice = firstBalancedObject(candidate);
    if (!slice) continue;
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function firstBalancedObject(source: string): string | null {
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}
