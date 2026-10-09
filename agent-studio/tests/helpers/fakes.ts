import type { ChatMessage, ChatPort } from "@/lib/model";
import type { CheckRunSummary, CompareFile, GitHubPort, PullSummary } from "@/lib/github";
import type { EngineContext } from "@/lib/engine";
import type { Run } from "@/lib/types";

/** In-memory GitHub double that behaves like the Git Data API for the operations the engine uses. */
export class FakeGitHub implements GitHubPort {
  readonly owner = "octo";
  readonly repo = "demo";
  readonly branches = new Map<string, string>([["main", "sha-0"]]);
  readonly commits = new Map<string, { tree: Map<string, string>; parent?: string }>();
  readonly checks = new Map<string, CheckRunSummary[]>();
  readonly commitMessages: string[] = [];
  pulls: (PullSummary & { head: string })[] = [];
  /** Outcome for each new commit's CI run, consumed in order. Defaults to success. */
  checkOutcomes: ("success" | "failure" | "pending" | "none")[] = [];
  private counter = 0;

  constructor() {
    this.commits.set("sha-0", { tree: new Map([["README.md", "# Demo\n"], ["package.json", "{}\n"]]) });
  }

  private nextSha(): string {
    this.counter += 1;
    return `sha-${this.counter}`;
  }

  async getBranchSha(branch: string): Promise<string | null> {
    return this.branches.get(branch) ?? null;
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    if (this.branches.has(branch)) throw new Error("Reference already exists");
    this.branches.set(branch, sha);
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    return this.commits.get(ref)?.tree.get(path) ?? null;
  }

  async listTree(ref: string): Promise<string[]> {
    return [...(this.commits.get(ref)?.tree.keys() ?? [])];
  }

  async commitFiles(input: {
    branch: string;
    parentSha: string;
    message: string;
    files: { path: string; content: string }[];
    author: { name: string; email: string };
  }): Promise<string> {
    const parent = this.commits.get(input.parentSha);
    if (!parent) throw new Error("parent missing");
    const tree = new Map(parent.tree);
    for (const file of input.files) tree.set(file.path, file.content);
    const sha = this.nextSha();
    this.commits.set(sha, { tree, parent: input.parentSha });
    this.commitMessages.push(input.message);
    this.branches.set(input.branch, sha);
    const outcome = this.checkOutcomes.shift() ?? "success";
    if (outcome === "success") {
      this.checks.set(sha, [{ name: "ci", status: "completed", conclusion: "success", url: `https://ci/${sha}` }]);
    } else if (outcome === "failure") {
      this.checks.set(sha, [
        { name: "ci", status: "completed", conclusion: "failure", url: `https://ci/${sha}`, detail: "tsc: error TS2304" },
      ]);
    } else if (outcome === "pending") {
      this.checks.set(sha, [{ name: "ci", status: "in_progress", conclusion: null, url: `https://ci/${sha}` }]);
    }
    return sha;
  }

  async compare(base: string, head: string): Promise<{ aheadBy: number; files: CompareFile[] }> {
    const before = this.commits.get(base)?.tree ?? new Map<string, string>();
    const after = this.commits.get(head)?.tree ?? new Map<string, string>();
    const files: CompareFile[] = [];
    for (const [path, content] of after) {
      const previous = before.get(path);
      if (previous === content) continue;
      const added = content.split("\n").map((line) => `+${line}`).join("\n");
      files.push({
        path,
        status: previous === undefined ? "added" : "modified",
        additions: content.split("\n").length,
        deletions: previous === undefined ? 0 : 1,
        patch: added,
      });
    }
    return { aheadBy: files.length, files };
  }

  async checkRuns(sha: string): Promise<CheckRunSummary[]> {
    return this.checks.get(sha) ?? [];
  }

  async findOpenPull(head: string): Promise<PullSummary | null> {
    const found = this.pulls.find((pull) => pull.head === head && pull.state === "open");
    return found ? { number: found.number, url: found.url, state: found.state, merged: found.merged } : null;
  }

  async createPull(input: { title: string; head: string; base: string; body: string }): Promise<PullSummary> {
    const number = this.pulls.length + 1;
    const pull = { number, url: `https://github.com/octo/demo/pull/${number}`, state: "open" as const, merged: false, head: input.head };
    this.pulls.push(pull);
    return { number, url: pull.url, state: pull.state, merged: false };
  }

  async getPull(number: number): Promise<PullSummary> {
    const pull = this.pulls.find((item) => item.number === number);
    if (!pull) throw new Error("not found");
    return { number, url: pull.url, state: pull.state, merged: pull.merged };
  }

  async mergePull(number: number): Promise<void> {
    const pull = this.pulls.find((item) => item.number === number);
    if (!pull) throw new Error("not found");
    pull.merged = true;
    pull.state = "closed";
  }
}

/** Deterministic model double. Chooses a canned reply based on which agent prompt it receives. */
export class FakeModel implements ChatPort {
  readonly model = "fake-free-model";
  readonly systemPrompts: string[] = [];
  patchCounter = 0;
  /** Contents returned by successive patch replies; the last one repeats. */
  patchContents: string[] = [];
  reviewReply = '{"verdict":"pass","findings":[]}';
  auditResult: "met" | "unmet" = "met";
  requirementIds: string[] = ["R1", "R2", "R3", "R4", "R5"];

  async chat(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
    const system = messages[0]?.content ?? "";
    this.systemPrompts.push(system);
    if (system.includes('"summary"')) {
      const content =
        this.patchContents[Math.min(this.patchCounter, this.patchContents.length - 1)] ??
        `export const feature = ${this.patchCounter};\n`;
      this.patchCounter += 1;
      return {
        text: `Here is the patch:\n${JSON.stringify({
          summary: `Implement feature ${this.patchCounter}`,
          files: [{ path: `app/feature-${this.patchCounter}.ts`, content }],
        })}`,
        model: this.model,
      };
    }
    if (system.includes("Code Review agent")) return { text: this.reviewReply, model: this.model };
    if (system.includes("independent auditor")) {
      const results = this.requirementIds.map((id) => ({ id, status: this.auditResult, evidence: "found in diff" }));
      return { text: JSON.stringify({ results }), model: this.model };
    }
    return { text: "Concise note: decisions, risks and the next step.", model: this.model };
  }
}

export class FixedClock {
  private time: number;
  constructor(start: string) {
    this.time = Date.parse(start);
  }
  now = (): Date => new Date(this.time);
  advance(ms: number): void {
    this.time += ms;
  }
}

export function makeContext(
  overrides: Partial<EngineContext> & { clock: FixedClock; github: GitHubPort | null; model: ChatPort | null },
): EngineContext {
  const { clock, ...rest } = overrides;
  return {
    now: clock.now,
    github: rest.github,
    model: rest.model,
    deploy: rest.deploy ?? {
      productionUrl: "https://example.com",
      hookUrl: undefined,
      verify: async () => ({ ok: true, status: 200, title: "Demo", durationMs: 5, checkedAt: clock.now().toISOString() }),
      triggerHook: async () => ({ ok: true, status: 201 }),
    },
    allowMerge: rest.allowMerge ?? false,
    pathPolicy: rest.pathPolicy ?? { allow: ["app/", "README.md"], maxFiles: 6, maxBytesPerFile: 60_000 },
    author: rest.author ?? { name: "agent-studio[bot]", email: "bot@example.com" },
    secrets: rest.secrets ?? [],
    actor: rest.actor ?? "owner",
  };
}

export function runSummary(run: Run): string {
  return run.order.map((id) => `${id}:${run.tasks[id].status}`).join(" ");
}
