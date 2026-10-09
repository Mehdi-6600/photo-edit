import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "./types";
import { type EnvLike, redact } from "./security";

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target?: string;
  result: "ok" | "error" | "denied";
  detail?: string;
}

export interface StudioStore {
  readonly kind: "memory" | "file" | "upstash";
  getRun(id: string): Promise<Run | null>;
  /** Saves a run only if the stored version equals run.version; increments run.version on success. */
  saveRun(run: Run): Promise<void>;
  listRuns(limit: number): Promise<Run[]>;
  getValue<T>(key: string): Promise<T | null>;
  setValue<T>(key: string, value: T): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}

export class ConflictError extends Error {
  constructor() {
    super("The run was modified by another request.");
    this.name = "ConflictError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{5,62}$/;
const KEY = /^[a-z0-9:_.-]{1,120}$/i;
const AUDIT_LIMIT = 500;

export function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new InvalidInputError("Invalid run id.");
}

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new InvalidInputError("Invalid storage key.");
}

/* ------------------------------------------------------------ memory */

export function createMemoryStore(): StudioStore {
  const runs = new Map<string, Run>();
  const values = new Map<string, string>();
  let audit: AuditEntry[] = [];

  return {
    kind: "memory",
    async getRun(id) {
      assertRunId(id);
      const found = runs.get(id);
      return found ? (JSON.parse(JSON.stringify(found)) as Run) : null;
    },
    async saveRun(run) {
      assertRunId(run.id);
      const storedVersion = runs.get(run.id)?.version ?? 0;
      if (storedVersion !== run.version) throw new ConflictError();
      run.version = storedVersion + 1;
      runs.set(run.id, JSON.parse(JSON.stringify(run)) as Run);
    },
    async listRuns(limit) {
      return [...runs.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((run) => JSON.parse(JSON.stringify(run)) as Run);
    },
    async getValue<T>(key: string) {
      assertKey(key);
      const raw = values.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async setValue<T>(key: string, value: T) {
      assertKey(key);
      values.set(key, JSON.stringify(value));
    },
    async appendAudit(entry) {
      audit = [{ ...entry }, ...audit].slice(0, AUDIT_LIMIT);
    },
    async listAudit(limit) {
      return audit.slice(0, limit).map((entry) => ({ ...entry }));
    },
  };
}

/* -------------------------------------------------------------- file */

function fileSafeKey(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${key.replace(/[^a-z0-9_.-]/gi, "_")}-${digest}`;
}

export function createFileStore(directory: string): StudioStore {
  const runsDir = path.join(directory, "runs");
  const kvDir = path.join(directory, "kv");
  const auditFile = path.join(directory, "audit.json");
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data), "utf8");
    await rename(temp, file);
  }

  return {
    kind: "file",
    async getRun(id) {
      assertRunId(id);
      return readJson<Run>(path.join(runsDir, `${id}.json`));
    },
    async saveRun(run) {
      assertRunId(run.id);
      return serialize(async () => {
        const file = path.join(runsDir, `${run.id}.json`);
        const stored = await readJson<Run>(file);
        const storedVersion = stored?.version ?? 0;
        if (storedVersion !== run.version) throw new ConflictError();
        run.version = storedVersion + 1;
        await writeJson(file, run);
      });
    },
    async listRuns(limit) {
      let names: string[] = [];
      try {
        names = await readdir(runsDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const runs: Run[] = [];
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const run = await readJson<Run>(path.join(runsDir, name));
        if (run) runs.push(run);
      }
      return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    },
    async getValue<T>(key: string) {
      assertKey(key);
      return readJson<T>(path.join(kvDir, `${fileSafeKey(key)}.json`));
    },
    async setValue<T>(key: string, value: T) {
      assertKey(key);
      return serialize(() => writeJson(path.join(kvDir, `${fileSafeKey(key)}.json`), value));
    },
    async appendAudit(entry) {
      return serialize(async () => {
        const current = (await readJson<AuditEntry[]>(auditFile)) ?? [];
        await writeJson(auditFile, [entry, ...current].slice(0, AUDIT_LIMIT));
      });
    },
    async listAudit(limit) {
      return ((await readJson<AuditEntry[]>(auditFile)) ?? []).slice(0, limit);
    },
  };
}

/* ----------------------------------------------------- upstash REST */

type Fetch = typeof fetch;

export function createUpstashStore(url: string, token: string, fetchImpl: Fetch = fetch): StudioStore {
  const base = url.replace(/\/+$/, "");

  async function command<T>(...args: (string | number)[]): Promise<T> {
    const response = await fetchImpl(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!response.ok || data.error) {
      throw new Error(`Storage request failed: ${redact(data.error ?? response.statusText, [token])}`);
    }
    return data.result as T;
  }

  const parse = <T>(raw: string | null | undefined): T | null => (raw ? (JSON.parse(raw) as T) : null);

  return {
    kind: "upstash",
    async getRun(id) {
      assertRunId(id);
      return parse<Run>(await command<string | null>("GET", `as:run:${id}`));
    },
    async saveRun(run) {
      assertRunId(run.id);
      const stored = parse<Run>(await command<string | null>("GET", `as:run:${run.id}`));
      const storedVersion = stored?.version ?? 0;
      if (storedVersion !== run.version) throw new ConflictError();
      run.version = storedVersion + 1;
      await command("SET", `as:run:${run.id}`, JSON.stringify(run));
      await command("ZADD", "as:runs", Date.parse(run.updatedAt) || Date.now(), run.id);
    },
    async listRuns(limit) {
      const ids = await command<string[]>("ZREVRANGE", "as:runs", 0, Math.max(0, limit - 1));
      if (ids.length === 0) return [];
      const raw = await command<(string | null)[]>("MGET", ...ids.map((id) => `as:run:${id}`));
      return raw.map((item) => parse<Run>(item)).filter((item): item is Run => item !== null);
    },
    async getValue<T>(key: string) {
      assertKey(key);
      return parse<T>(await command<string | null>("GET", `as:kv:${key}`));
    },
    async setValue<T>(key: string, value: T) {
      assertKey(key);
      await command("SET", `as:kv:${key}`, JSON.stringify(value));
    },
    async appendAudit(entry) {
      await command("LPUSH", "as:audit", JSON.stringify(entry));
      await command("LTRIM", "as:audit", 0, AUDIT_LIMIT - 1);
    },
    async listAudit(limit) {
      const items = await command<string[]>("LRANGE", "as:audit", 0, Math.max(0, limit - 1));
      return items.map((item) => JSON.parse(item) as AuditEntry);
    },
  };
}

/* ----------------------------------------------------------- factory */

export function createStoreFromEnv(env: EnvLike = process.env): StudioStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createUpstashStore(url, token);
  if (env.VERCEL) return createMemoryStore();
  return createFileStore(env.AGENT_STUDIO_DATA_DIR || path.join(process.cwd(), ".data"));
}
