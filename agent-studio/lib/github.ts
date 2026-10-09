import { redact } from "./security";

/** Narrow interface the orchestrator depends on. Tests provide an in-memory fake. */
export interface CompareFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  /** Short failure output from the check (title and summary), used as debugging context. */
  detail?: string;
}

export interface PullSummary {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
}

export interface GitHubPort {
  readonly owner: string;
  readonly repo: string;
  getBranchSha(branch: string): Promise<string | null>;
  createBranch(branch: string, sha: string): Promise<void>;
  readFile(path: string, ref: string): Promise<string | null>;
  listTree(ref: string): Promise<string[]>;
  commitFiles(input: {
    branch: string;
    parentSha: string;
    message: string;
    files: { path: string; content: string }[];
    author: { name: string; email: string };
  }): Promise<string>;
  compare(base: string, head: string): Promise<{ aheadBy: number; files: CompareFile[] }>;
  checkRuns(sha: string): Promise<CheckRunSummary[]>;
  findOpenPull(head: string): Promise<PullSummary | null>;
  createPull(input: { title: string; head: string; base: string; body: string }): Promise<PullSummary>;
  getPull(number: number): Promise<PullSummary>;
  mergePull(number: number, title: string): Promise<void>;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  permissions: { admin: boolean; push: boolean; pull: boolean };
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

const API_BASE = "https://api.github.com";
const MAX_FILE_BYTES = 200_000;

export function parseRepoSlug(value: string | undefined | null): { owner: string; name: string } | null {
  if (!value) return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value.trim());
  if (!match) return null;
  if (match[2] === "." || match[2] === "..") return null;
  return { owner: match[1], name: match[2] };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GitHubClient implements GitHubPort {
  readonly owner: string;
  readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    token: string,
    owner: string,
    repo: string,
    options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleepDefault;
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  /** Performs one GitHub REST call with bounded retries for rate limits and transient failures. */
  async request<T>(method: string, path: string, body?: unknown, allowNotFound = false): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-studio",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (attempt < 3) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw new GitHubError("Could not reach GitHub. Check the network and try again.", 0);
      }

      const retryAfter = response.headers.get("retry-after");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const limited = response.status === 429 || (response.status === 403 && (remaining === "0" || retryAfter !== null));
      if ((limited || response.status >= 500) && attempt < 3) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : Number.isFinite(reset) && reset > 0
            ? Math.max(0, reset * 1000 - Date.now())
            : 2000 * attempt;
        if (waitMs <= 15000) {
          await this.sleep(waitMs);
          continue;
        }
      }

      if (response.status === 404 && allowNotFound) return null;
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        const message = data?.message ?? response.statusText;
        throw new GitHubError(redact(`GitHub returned ${response.status}: ${message}`, [this.token]), response.status);
      }
      return data as T;
    }
  }

  async viewerLogin(): Promise<string> {
    const data = await this.request<{ login: string }>("GET", "/user");
    return data?.login ?? "unknown";
  }

  async getRepo(): Promise<RepoInfo> {
    const data = await this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
      archived: boolean;
      html_url: string;
      permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    }>("GET", this.repoPath(""));
    if (!data) throw new GitHubError("Repository not found or not visible to this token.", 404);
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      private: data.private,
      archived: data.archived,
      htmlUrl: data.html_url,
      permissions: {
        admin: Boolean(data.permissions?.admin),
        push: Boolean(data.permissions?.push),
        pull: Boolean(data.permissions?.pull),
      },
    };
  }

  async getBranchSha(branch: string): Promise<string | null> {
    const data = await this.request<{ object?: { sha?: string } }>(
      "GET",
      this.repoPath(`/git/ref/heads/${encodePath(branch)}`),
      undefined,
      true,
    );
    return data?.object?.sha ?? null;
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.request("POST", this.repoPath("/git/refs"), { ref: `refs/heads/${branch}`, sha });
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const data = await this.request<{ type?: string; encoding?: string; content?: string; size?: number }>(
      "GET",
      this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`),
      undefined,
      true,
    );
    if (!data || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") return null;
    if ((data.size ?? 0) > MAX_FILE_BYTES) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async listTree(ref: string): Promise<string[]> {
    const data = await this.request<{ tree?: { path: string; type: string }[] }>(
      "GET",
      this.repoPath(`/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    );
    return (data?.tree ?? []).filter((item) => item.type === "blob").map((item) => item.path).slice(0, 3000);
  }

  async commitFiles(input: {
    branch: string;
    parentSha: string;
    message: string;
    files: { path: string; content: string }[];
    author: { name: string; email: string };
  }): Promise<string> {
    const parent = await this.request<{ tree: { sha: string } }>("GET", this.repoPath(`/git/commits/${input.parentSha}`));
    if (!parent) throw new GitHubError("Parent commit not found.", 404);

    const treeEntries: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const file of input.files) {
      const blob = await this.request<{ sha: string }>("POST", this.repoPath("/git/blobs"), {
        content: file.content,
        encoding: "utf-8",
      });
      if (!blob) throw new GitHubError("Could not create a blob.", 500);
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const tree = await this.request<{ sha: string }>("POST", this.repoPath("/git/trees"), {
      base_tree: parent.tree.sha,
      tree: treeEntries,
    });
    if (!tree) throw new GitHubError("Could not create a tree.", 500);

    const commit = await this.request<{ sha: string }>("POST", this.repoPath("/git/commits"), {
      message: input.message,
      tree: tree.sha,
      parents: [input.parentSha],
      author: input.author,
    });
    if (!commit) throw new GitHubError("Could not create a commit.", 500);

    // force:false makes GitHub reject non-fast-forward updates, which protects against silent overwrites.
    await this.request("PATCH", this.repoPath(`/git/refs/heads/${encodePath(input.branch)}`), {
      sha: commit.sha,
      force: false,
    });
    return commit.sha;
  }

  async compare(base: string, head: string): Promise<{ aheadBy: number; files: CompareFile[] }> {
    const data = await this.request<{
      ahead_by?: number;
      files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
    }>("GET", this.repoPath(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`));
    return {
      aheadBy: data?.ahead_by ?? 0,
      files: (data?.files ?? []).slice(0, 100).map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      })),
    };
  }

  async checkRuns(sha: string): Promise<CheckRunSummary[]> {
    const data = await this.request<{
      check_runs?: {
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string | null;
        output?: { title?: string | null; summary?: string | null; text?: string | null };
      }[];
    }>("GET", this.repoPath(`/commits/${sha}/check-runs?per_page=100`));
    return (data?.check_runs ?? []).map((run) => {
      const detail = [run.output?.title, run.output?.summary, run.output?.text]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n")
        .slice(0, 2000);
      return {
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url ?? "",
        detail: detail || undefined,
      };
    });
  }

  async findOpenPull(head: string): Promise<PullSummary | null> {
    const data = await this.request<{ number: number; html_url: string; state: "open" | "closed"; merged_at: string | null }[]>(
      "GET",
      this.repoPath(`/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${head}`)}&per_page=5`),
    );
    const first = data?.[0];
    return first ? { number: first.number, url: first.html_url, state: first.state, merged: Boolean(first.merged_at) } : null;
  }

  async createPull(input: { title: string; head: string; base: string; body: string }): Promise<PullSummary> {
    const data = await this.request<{ number: number; html_url: string; state: "open" | "closed"; merged_at: string | null }>(
      "POST",
      this.repoPath("/pulls"),
      { title: input.title, head: input.head, base: input.base, body: input.body, draft: false },
    );
    if (!data) throw new GitHubError("Pull request was not created.", 500);
    return { number: data.number, url: data.html_url, state: data.state, merged: Boolean(data.merged_at) };
  }

  async getPull(number: number): Promise<PullSummary> {
    const data = await this.request<{ number: number; html_url: string; state: "open" | "closed"; merged_at: string | null }>(
      "GET",
      this.repoPath(`/pulls/${number}`),
    );
    if (!data) throw new GitHubError("Pull request not found.", 404);
    return { number: data.number, url: data.html_url, state: data.state, merged: Boolean(data.merged_at) };
  }

  async mergePull(number: number, title: string): Promise<void> {
    await this.request("PUT", this.repoPath(`/pulls/${number}/merge`), {
      merge_method: "squash",
      commit_title: title,
    });
  }

  /** Lightweight read-only snapshot used by the GitHub screen. */
  async snapshot(): Promise<{
    repo: RepoInfo;
    commits: { sha: string; message: string; author: string; date: string }[];
    pulls: { number: number; title: string; url: string; head: string }[];
    topLevel: string[];
  }> {
    const repo = await this.getRepo();
    const commitData = await this.request<
      { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
    >("GET", this.repoPath(`/commits?sha=${encodeURIComponent(repo.defaultBranch)}&per_page=5`));
    const pullData = await this.request<{ number: number; title: string; html_url: string; head: { ref: string } }[]>(
      "GET",
      this.repoPath("/pulls?state=open&per_page=5"),
    );
    const tree = await this.listTree(repo.defaultBranch);
    const topLevel = [...new Set(tree.map((path) => path.split("/")[0]))].slice(0, 40);
    return {
      repo,
      commits: (commitData ?? []).map((item) => ({
        sha: item.sha.slice(0, 7),
        message: item.commit.message.split("\n")[0].slice(0, 120),
        author: item.commit.author.name,
        date: item.commit.author.date,
      })),
      pulls: (pullData ?? []).map((item) => ({
        number: item.number,
        title: item.title.slice(0, 120),
        url: item.html_url,
        head: item.head.ref,
      })),
      topLevel,
    };
  }
}
