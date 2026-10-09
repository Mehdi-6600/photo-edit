import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, parseRepoSlug } from "@/lib/github";
import { createRun } from "@/lib/engine";
import { analyzeIdeaHeuristic } from "@/lib/planner";
import { triggerDeployHook, validateDeployHookUrl, verifyProductionUrl } from "@/lib/deploy";
import { ConflictError, createFileStore, createMemoryStore, createUpstashStore, InvalidInputError } from "@/lib/store";
import type { Run } from "@/lib/types";

const NOW = new Date("2026-10-09T09:00:00Z");

function makeRun(id = "r-store-0001"): Run {
  return createRun(analyzeIdeaHeuristic("Build a small timer app for teachers.", NOW), { id, now: NOW });
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe("run storage", () => {
  it("rejects a save when the stored version is not the one the client read", async () => {
    const store = createMemoryStore();
    const run = makeRun();
    await store.saveRun(run);
    expect(run.version).toBe(1);
    const stale = await store.getRun(run.id);
    const current = await store.getRun(run.id);
    expect(stale && current).toBeTruthy();
    current!.title = "Edited elsewhere";
    await store.saveRun(current!);
    stale!.title = "Stale edit";
    await expect(store.saveRun(stale!)).rejects.toBeInstanceOf(ConflictError);
    expect((await store.getRun(run.id))?.title).toBe(current!.title);
  });

  it("persists to disk, lists newest first and rejects invalid ids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "as-store-"));
    dirs.push(dir);
    const store = createFileStore(dir);
    const first = makeRun("r-first-0001");
    await store.saveRun(first);
    const second = makeRun("r-second-02");
    second.updatedAt = new Date(NOW.getTime() + 60_000).toISOString();
    await store.saveRun(second);
    const listed = await store.listRuns(10);
    expect(listed.map((item) => item.id)).toEqual(["r-second-02", "r-first-0001"]);
    await expect(store.getRun("../../etc/passwd")).rejects.toBeInstanceOf(InvalidInputError);
    await store.setValue("registry:overrides", { a: { enabled: true } });
    expect(await store.getValue("registry:overrides")).toEqual({ a: { enabled: true } });
  });

  it("keeps the audit trail bounded and newest first", async () => {
    const store = createMemoryStore();
    for (let index = 0; index < 510; index += 1) {
      await store.appendAudit({ at: NOW.toISOString(), actor: "owner", action: `a${index}`, result: "ok" });
    }
    const audit = await store.listAudit(1000);
    expect(audit).toHaveLength(500);
    expect(audit[0].action).toBe("a509");
  });

  it("speaks the Upstash REST protocol for persistence", async () => {
    const data = new Map<string, string>();
    const sets = new Map<string, Map<string, number>>();
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const [command, ...args] = JSON.parse(String(init?.body)) as string[];
      let result: unknown = null;
      if (command === "GET") result = data.get(args[0]) ?? null;
      if (command === "SET") data.set(args[0], args[1]);
      if (command === "ZADD") {
        const set = sets.get(args[0]) ?? new Map<string, number>();
        set.set(args[2], Number(args[1]));
        sets.set(args[0], set);
        result = 1;
      }
      if (command === "ZREVRANGE") {
        const set = [...(sets.get(args[0])?.entries() ?? [])].sort((a, b) => b[1] - a[1]).map(([member]) => member);
        result = set.slice(Number(args[1]), Number(args[2]) + 1);
      }
      if (command === "MGET") result = args.map((key) => data.get(key) ?? null);
      return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const store = createUpstashStore("https://db.upstash.io", "token-value-123456", fakeFetch);
    const run = makeRun("r-upstash-01");
    await store.saveRun(run);
    expect(await store.getRun(run.id)).toMatchObject({ id: run.id, version: 1 });
    expect((await store.listRuns(5)).map((item) => item.id)).toEqual([run.id]);
    await store.setValue("settings:github-repository", { owner: "octo", name: "demo" });
    expect(await store.getValue("settings:github-repository")).toEqual({ owner: "octo", name: "demo" });
  });
});

describe("GitHub client", () => {
  it("parses owner/name and rejects unsafe values", () => {
    expect(parseRepoSlug("Mehdi-6600/photo-edit")).toEqual({ owner: "Mehdi-6600", name: "photo-edit" });
    expect(parseRepoSlug("owner/..")).toBeNull();
    expect(parseRepoSlug("owner/name/extra")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });

  it("retries rate limits and returns null for missing refs", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/git/ref/heads/missing")) return new Response("{}", { status: 404 });
      if (calls.length === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
    }) as typeof fetch;
    const client = new GitHubClient("ghp_testtoken_value_1234567890", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    expect(await client.getBranchSha("main")).toBe("abc123");
    expect(await client.getBranchSha("missing")).toBeNull();
    expect(calls.length).toBe(3);
  });

  it("never includes the token in thrown errors", async () => {
    const token = "ghp_testtoken_value_1234567890";
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: `Bad credentials for ${token}` }), { status: 401 })) as typeof fetch;
    const client = new GitHubClient(token, "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const error = await client.getRepo().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).not.toContain(token);
  });

  it("creates a commit with blobs, tree and fast-forward ref update", async () => {
    const requests: { method: string; url: string; body?: unknown }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: String(url), body });
      let payload: unknown = {};
      if (method === "GET" && String(url).includes("/git/commits/parent1")) payload = { tree: { sha: "tree0" } };
      if (method === "POST" && String(url).endsWith("/git/blobs")) payload = { sha: `blob-${requests.length}` };
      if (method === "POST" && String(url).endsWith("/git/trees")) payload = { sha: "tree1" };
      if (method === "POST" && String(url).endsWith("/git/commits")) payload = { sha: "commit1" };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const client = new GitHubClient("tok", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const sha = await client.commitFiles({
      branch: "agent/demo-abc123",
      parentSha: "parent1",
      message: "agent(frontend): change",
      files: [{ path: "app/page.tsx", content: "export default 1;" }],
      author: { name: "bot", email: "bot@example.com" },
    });
    expect(sha).toBe("commit1");
    const treeCall = requests.find((item) => item.url.endsWith("/git/trees"));
    expect(treeCall?.body).toMatchObject({ base_tree: "tree0" });
    const refCall = requests.find((item) => item.method === "PATCH");
    expect(refCall?.url).toContain("/git/refs/heads/agent/demo-abc123");
    expect(refCall?.body).toEqual({ sha: "commit1", force: false });
  });
});

describe("production checks and deploy hooks", () => {
  it("passes only for HTTP 200 HTML pages", async () => {
    const ok = await verifyProductionUrl("https://example.com", (async () =>
      new Response("<!doctype html><html><head><title>Demo</title></head></html>", { status: 200 })) as typeof fetch);
    expect(ok.ok).toBe(true);
    expect(ok.title).toBe("Demo");
    const down = await verifyProductionUrl("https://example.com", (async () => new Response("oops", { status: 503 })) as typeof fetch);
    expect(down.ok).toBe(false);
    expect(down.reason).toContain("503");
    const notHtml = await verifyProductionUrl("https://example.com", (async () => new Response("{}", { status: 200 })) as typeof fetch);
    expect(notHtml.ok).toBe(false);
    const unsafe = await verifyProductionUrl("http://example.com", (async () => new Response("", { status: 200 })) as typeof fetch);
    expect(unsafe.ok).toBe(false);
  });

  it("only triggers Vercel deploy hooks", async () => {
    expect(() => validateDeployHookUrl("https://evil.example/v1/integrations/deploy/a")).toThrow();
    expect(() => validateDeployHookUrl("https://api.vercel.com/v9/other")).toThrow();
    let called = "";
    const result = await triggerDeployHook(
      "https://api.vercel.com/v1/integrations/deploy/prj_1/abc",
      (async (url: string | URL | Request) => {
        called = String(url);
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    );
    expect(result).toEqual({ ok: true, status: 201 });
    expect(called).toBe("https://api.vercel.com/v1/integrations/deploy/prj_1/abc");
  });
});
