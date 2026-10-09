import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, parseRepoSlug } from "@/lib/github";
import { createRun } from "@/lib/engine";
import { analyzeIdeaHeuristic } from "@/lib/planner";
import { listVercelDeployments, triggerDeployHook, validateDeployHookUrl, verifyProductionUrl } from "@/lib/deploy";
import { ConflictError, createFileStore, createMemoryStore, createUpstashStore, InvalidInputError } from "@/lib/store";
import { createProjectRun, createServices, isWithinRepositoryLock, readConfig, repositoryLockState, REPO_SETTING_KEY } from "@/lib/services";
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

  it("rejects insecure, credential-bearing, or non-Upstash endpoints", () => {
    expect(() => createUpstashStore("http://db.upstash.io", "token-value-123456")).toThrow(/HTTPS/);
    expect(() => createUpstashStore("https://user:pass@db.upstash.io", "token-value-123456")).toThrow(/embedded credentials/);
    expect(() => createUpstashStore("https://evil.example", "token-value-123456")).toThrow(/upstash.io/);
    expect(() => createUpstashStore("https://db.upstash.io/extra", "token-value-123456")).toThrow(/upstash.io/);
  });

  it("speaks the Upstash REST protocol for persistence", async () => {
    const data = new Map<string, string>();
    const sets = new Map<string, Map<string, number>>();
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const [command, ...args] = JSON.parse(String(init?.body)) as string[];
      let result: unknown = null;
      if (command === "GET") result = data.get(args[0]) ?? null;
      if (command === "SET") data.set(args[0], args[1]);
      if (command === "EVAL") {
        expect(args[0]).toContain("\n");
        const stored = data.get(args[2]);
        const storedVersion = stored ? (JSON.parse(stored) as Run).version : 0;
        if (storedVersion !== Number(args[4])) {
          result = 0;
        } else {
          data.set(args[2], args[6]);
          const set = sets.get(args[3]) ?? new Map<string, number>();
          set.set(args[7], Number(args[5]));
          sets.set(args[3], set);
          result = 1;
        }
      }
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
    const stale = await store.getRun(run.id);
    const latest = await store.getRun(run.id);
    latest!.title = "newest";
    await store.saveRun(latest!);
    stale!.title = "stale";
    await expect(store.saveRun(stale!)).rejects.toBeInstanceOf(ConflictError);
    expect((await store.getRun(run.id))?.title).toBe("newest");
  });
});

describe("repository selection lock", () => {
  it("does not start a delivery run without a selected GitHub repository", async () => {
    const store = createMemoryStore();
    const services = createServices(readConfig({}), store, () => NOW);
    const plan = analyzeIdeaHeuristic("Build a small timer app for teachers.", NOW);
    await expect(createProjectRun(services, plan)).rejects.toThrow(/Select a GitHub repository/);
    expect(await store.listRuns(10)).toHaveLength(0);
  });

  it("ignores saved UI selection when GITHUB_REPOSITORY is configured", async () => {
    const store = createMemoryStore();
    await store.setValue(REPO_SETTING_KEY, { owner: "other", name: "repo" });
    const services = createServices(
      readConfig({ GITHUB_TOKEN: "token-value", GITHUB_REPOSITORY: "Owner/locked" }),
      store,
      () => NOW,
    );
    expect(await services.repository()).toEqual({ owner: "Owner", name: "locked" });
    expect(services.githubFor("other", "repo")).toBeNull();
    expect(services.githubFor("owner", "LOCKED")).not.toBeNull();
  });

  it("redacts configured credentials from the audit log", async () => {
    const secret = "owner-secret-value-123456";
    const store = createMemoryStore();
    const services = createServices(readConfig({ APP_ACCESS_TOKEN: secret }), store, () => NOW);
    await services.audit({ actor: "owner", action: "test", target: "target", result: "error", detail: `failed: ${secret}` });
    const entries = await store.listAudit(10);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(entries[0].detail).toContain("[REDACTED]");
  });

  it("fails closed when the configured repository lock is malformed", async () => {
    const store = createMemoryStore();
    await store.setValue(REPO_SETTING_KEY, { owner: "octo", name: "demo" });
    const config = readConfig({ GITHUB_TOKEN: "token-value", GITHUB_REPOSITORY: "../invalid" });
    const services = createServices(config, store, () => NOW);
    expect(config.repositoryConfigError).toContain("owner/name");
    expect(await services.repository()).toBeNull();
    expect(services.githubFor("octo", "demo")).toBeNull();
  });

  it("describes the lock state and tests membership case-insensitively", () => {
    expect(repositoryLockState({ githubRepository: { owner: "Owner", name: "Locked" }, repositoryConfigError: undefined })).toEqual({
      locked: true,
      reason: "environment",
      repository: { owner: "Owner", name: "Locked" },
    });
    expect(repositoryLockState({ githubRepository: undefined, repositoryConfigError: "GITHUB_REPOSITORY must use the owner/name format." })).toEqual({
      locked: true,
      reason: "config-error",
      repository: null,
    });
    expect(repositoryLockState({ githubRepository: undefined, repositoryConfigError: undefined })).toEqual({
      locked: false,
      reason: null,
      repository: null,
    });
    const lock = { owner: "Owner", name: "Locked" };
    expect(isWithinRepositoryLock(lock, "owner", "LOCKED")).toBe(true);
    expect(isWithinRepositoryLock(lock, "other", "locked")).toBe(false);
    expect(isWithinRepositoryLock(lock, "owner", "locked-again")).toBe(false);
    expect(isWithinRepositoryLock(null, "any", "repo")).toBe(true);
    expect(isWithinRepositoryLock(undefined, "any", "repo")).toBe(true);
  });
});

describe("GitHub client", () => {
  it("parses owner/name and rejects unsafe values", () => {
    expect(parseRepoSlug("Mehdi-6600/photo-edit")).toEqual({ owner: "Mehdi-6600", name: "photo-edit" });
    expect(parseRepoSlug("owner/..")).toBeNull();
    expect(parseRepoSlug("owner/name/extra")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });

  it("does not follow redirects while sending the GitHub token", async () => {
    let redirectMode = "";
    let calls = 0;
    let authorization = "";
    const client = new GitHubClient("github-token-value-123456", "octo", "demo", {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        redirectMode = String(init?.redirect);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
      }) as typeof fetch,
    });
    await expect(client.getRepo()).rejects.toThrow(/302/);
    expect(redirectMode).toBe("manual");
    expect(authorization).toBe("Bearer github-token-value-123456");
    expect(calls).toBe(1);
  });

  it("rejects unsafe browser links returned by GitHub", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({
        full_name: "octo/demo",
        default_branch: "main",
        private: true,
        archived: false,
        html_url: "javascript:alert(1)",
        permissions: { admin: false, push: true, pull: true },
      }), { status: 200 })) as typeof fetch;
    const client = new GitHubClient("token-value", "octo", "demo", { fetchImpl: fakeFetch });
    await expect(client.getRepo()).rejects.toThrow(/invalid web URL/);
  });

  it("retries rate limits and returns null for missing refs", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/git/ref/heads/missing")) return new Response("{}", { status: 404 });
      if (calls.length === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
    }) as typeof fetch;
    const client = new GitHubClient("test-token-value-1234567890", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    expect(await client.getBranchSha("main")).toBe("abc123");
    expect(await client.getBranchSha("missing")).toBeNull();
    expect(calls.length).toBe(3);
  });

  it("never includes the token in thrown errors", async () => {
    const token = "test-token-value-1234567890";
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: `Bad credentials for ${token}` }), { status: 401 })) as typeof fetch;
    const client = new GitHubClient(token, "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const error = await client.getRepo().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).not.toContain(token);
  });

  it("rejects direct writes to protected refs before making GitHub requests", async () => {
    let calls = 0;
    const client = new GitHubClient("token-value-123456", "octo", "demo", {
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await expect(client.createBranch("main", "sha-0")).rejects.toThrow("Agent branches must match");
    await expect(
      client.commitFiles({
        branch: "main",
        parentSha: "sha-0",
        message: "bad",
        files: [],
        author: { name: "test", email: "test@example.com" },
      }),
    ).rejects.toThrow("Agent branches must match");
    expect(calls).toBe(0);
  });

  it("probes GitHub read permissions without making any writes", async () => {
    const calls: { method: string; path: string }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? "GET";
      calls.push({ method, path: parsed.pathname + parsed.search });
      let payload: unknown = {};
      if (parsed.pathname === "/user") payload = { login: "octo" };
      else if (parsed.pathname === "/repos/octo/demo") {
        payload = {
          full_name: "octo/demo",
          default_branch: "main",
          private: true,
          archived: false,
          html_url: "https://github.com/octo/demo",
          permissions: { admin: false, push: true, pull: true },
        };
      } else if (parsed.pathname.endsWith("/git/ref/heads/main")) payload = { object: { sha: "base-sha" } };
      else if (parsed.pathname.endsWith("/git/trees/base-sha")) payload = { tree: [] };
      else if (parsed.pathname.endsWith("/check-runs")) payload = { check_runs: [] };
      else if (parsed.pathname.endsWith("/actions/runs")) payload = { workflow_runs: [] };
      else if (parsed.pathname.endsWith("/pulls")) payload = [];
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new GitHubClient("token-value", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const result = await client.probePermissions();
    expect(result).toMatchObject({
      authenticatedAs: "octo",
      defaultBranch: "main",
      repositoryReadable: true,
      contentsReadable: true,
      actionsReadable: true,
      checksReadable: true,
      pullRequestsReadable: true,
      accountCanPush: true,
    });
    expect(calls.length).toBe(7);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports partial access when some read probes are denied", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      let payload: unknown = {};
      let status = 200;
      if (parsed.pathname === "/user") payload = { login: "octo" };
      else if (parsed.pathname === "/repos/octo/demo") {
        payload = {
          full_name: "octo/demo",
          default_branch: "main",
          private: true,
          archived: false,
          html_url: "https://github.com/octo/demo",
          permissions: { admin: false, push: false, pull: true },
        };
      } else if (parsed.pathname.endsWith("/git/ref/heads/main")) payload = { object: { sha: "base-sha" } };
      else if (parsed.pathname.endsWith("/git/trees/base-sha")) payload = { tree: [] };
      else if (parsed.pathname.endsWith("/check-runs")) {
        payload = { message: "Resource not accessible by integration" };
        status = 403;
      } else if (parsed.pathname.endsWith("/actions/runs")) {
        payload = { message: "Resource not accessible by integration" };
        status = 403;
      } else if (parsed.pathname.endsWith("/pulls")) payload = [];
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
    const client = new GitHubClient("token-value", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const result = await client.probePermissions();
    expect(result).toMatchObject({
      authenticatedAs: "octo",
      repositoryReadable: true,
      contentsReadable: true,
      checksReadable: false,
      actionsReadable: false,
      pullRequestsReadable: true,
      accountCanPush: false,
    });
  });

  it("reports every probe unavailable when the token itself is rejected", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }) as typeof fetch;
    const client = new GitHubClient("bad-token", "octo", "demo", { fetchImpl: fakeFetch, sleep: async () => undefined });
    const result = await client.probePermissions();
    expect(result.authenticatedAs).toBeNull();
    expect(result.repositoryReadable).toBe(false);
    expect(result.contentsReadable).toBe(false);
    expect(result.actionsReadable).toBe(false);
    expect(result.checksReadable).toBe(false);
    expect(result.pullRequestsReadable).toBe(false);
    expect(result.accountCanPush).toBeNull();
    expect(calls).toBe(1);
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

  it("pins merges to the exact head SHA that passed review", async () => {
    let requestBody: unknown;
    const client = new GitHubClient("tok", "octo", "demo", {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      }) as typeof fetch,
    });
    await client.mergePull(42, "Reviewed project", "reviewed-sha");
    expect(requestBody).toEqual({ merge_method: "squash", commit_title: "Reviewed project", sha: "reviewed-sha" });

    const unconfirmed = new GitHubClient("tok", "octo", "demo", {
      fetchImpl: (async () => new Response(JSON.stringify({ merged: false }), { status: 200 })) as typeof fetch,
    });
    await expect(unconfirmed.mergePull(42, "Reviewed project", "reviewed-sha")).rejects.toThrow(/did not confirm/);
  });
});

describe("production checks and deploy hooks", () => {
  it("does not follow Vercel API redirects and validates deployment links", async () => {
    let redirectMode = "";
    const response = JSON.stringify({
      deployments: [{ uid: "d1", url: "preview-project.vercel.app", state: "READY", target: "preview", created: NOW.getTime() }],
    });
    const deployments = await listVercelDeployments(
      { token: "vercel-token-value-123456", projectId: "project-id" },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        redirectMode = String(init?.redirect);
        return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    );
    expect(redirectMode).toBe("manual");
    expect(deployments[0]?.url).toBe("https://preview-project.vercel.app/");

    await expect(listVercelDeployments(
      { token: "vercel-token-value-123456", projectId: "project-id" },
      (async () => new Response(JSON.stringify({
        deployments: [{ uid: "d1", url: "evil.example", state: "READY", created: NOW.getTime() }],
      }), { status: 200 })) as typeof fetch,
    )).rejects.toThrow(/invalid deployment URL/);
  });

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

  it("never follows redirects during production URL verification", async () => {
    let redirectMode = "";
    const result = await verifyProductionUrl("https://example.com", (async (_url: string | URL | Request, init?: RequestInit) => {
      redirectMode = String(init?.redirect);
      return new Response("", { status: 302, headers: { location: "https://127.0.0.1/" } });
    }) as typeof fetch);
    expect(redirectMode).toBe("manual");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(302);
  });

  it("only triggers Vercel deploy hooks", async () => {
    expect(() => validateDeployHookUrl("https://evil.example/v1/integrations/deploy/a")).toThrow();
    expect(() => validateDeployHookUrl("https://api.vercel.com/v9/other")).toThrow();
    let called = "";
    let redirectMode = "";
    const hook = "https://api.vercel.com/v1/integrations/deploy/" + "prj_1/abc";
    const result = await triggerDeployHook(
      hook,
      (async (url: string | URL | Request, init?: RequestInit) => {
        called = String(url);
        redirectMode = String(init?.redirect);
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    );
    expect(result).toEqual({ ok: true, status: 201 });
    expect(called).toBe(hook);
    expect(redirectMode).toBe("manual");
  });
});
