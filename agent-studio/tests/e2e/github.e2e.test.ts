/**
 * End-to-end check against the REAL GitHub API. It is skipped unless E2E_GITHUB=1.
 *
 * What is real: GitHub REST calls (branch, commits, check runs, pull request, compare),
 * the GitHub Actions CI run triggered by the push, and the HTTP client.
 * What is a stand-in: the language model. A local OpenAI-compatible server returns a fixed
 * patch, so the test proves the pipeline, not the quality of any model.
 *
 * Required env: E2E_GITHUB=1, GITHUB_TOKEN (least-privilege token for the test repo),
 * GITHUB_REPOSITORY=owner/name, E2E_BASE_BRANCH (a branch that contains the CI workflow).
 * The test closes its pull request and deletes its agent branch when it finishes.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/store";
import { ModelClient } from "@/lib/model";
import { readConfig, createServices, createProjectRun, advanceProjectRun, approveProjectGate, type Services } from "@/lib/services";
import { analyzeIdeaHeuristic } from "@/lib/planner";
import { GitHubClient, parseRepoSlug } from "@/lib/github";
import type { Run } from "@/lib/types";

const enabled = process.env.E2E_GITHUB === "1";
const RUN_TIMEOUT_MS = 40 * 60 * 1000;

function startMockModel(): Promise<{ server: Server; baseUrl: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { messages?: { role: string; content: string }[] };
      const system = parsed.messages?.[0]?.content ?? "";
      calls.push(system.slice(0, 40));
      let text = "Notes: keep the change small and reviewable.";
      if (system.includes('"summary"')) {
        const content = `export const agentRun = "e2e-${Date.now()}";\n`;
        text = JSON.stringify({
          summary: "Add E2E marker module",
          files: [{ path: "agent-studio/docs/e2e/agent-run.ts", content }],
        });
      } else if (system.includes("Code Review agent")) {
        text = '{"verdict":"pass","findings":[]}';
      } else if (system.includes("independent auditor")) {
        text = JSON.stringify({ results: [{ id: "R1", status: "met", evidence: "marker module present" }] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-openai-compatible", choices: [{ message: { content: text } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, calls });
    });
  });
}

describe.skipIf(!enabled)("GitHub end-to-end delivery (real API)", () => {
  let services: Services;
  let github: GitHubClient;
  let mock: { server: Server; baseUrl: string; calls: string[] };
  let runId = "";
  let branch = "";
  let pullNumber = 0;

  beforeAll(async () => {
    const env = { ...process.env };
    const slug = parseRepoSlug(env.GITHUB_REPOSITORY);
    if (!slug || !env.GITHUB_TOKEN || !env.E2E_BASE_BRANCH) throw new Error("Set GITHUB_REPOSITORY, GITHUB_TOKEN and E2E_BASE_BRANCH.");
    mock = await startMockModel();
    const config = readConfig({
      ...env,
      LLM_BASE_URL: mock.baseUrl,
      LLM_MODEL: "mock-openai-compatible",
      LLM_API_KEY: "",
      AGENT_STUDIO_ALLOW_MERGE: "false",
    });
    services = createServices(config, createMemoryStore());
    github = new GitHubClient(env.GITHUB_TOKEN, slug.owner, slug.name);
    expect(services.model).not.toBeNull();
    expect(services.model).toBeInstanceOf(ModelClient);
  });

  afterAll(async () => {
    if (pullNumber) {
      await github.request("PATCH", `/repos/${github.owner}/${github.repo}/pulls/${pullNumber}`, { state: "closed" }).catch(() => undefined);
    }
    if (branch) {
      await github.request("DELETE", `/repos/${github.owner}/${github.repo}/git/refs/heads/${branch}`).catch(() => undefined);
    }
    await new Promise<void>((resolve) => mock?.server.close(() => resolve()) ?? resolve());
  });

  it(
    "takes a plan through a real branch, real CI, a real pull request and an approval gate",
    async () => {
      const base = process.env.E2E_BASE_BRANCH as string;
      const plan = analyzeIdeaHeuristic("Add an E2E marker module that proves the agent pipeline works end to end.", new Date());
      const run = await createProjectRun(services, plan);
      runId = run.id;
      // Point the run at the branch that carries the CI workflow. Production runs use the default branch.
      const stored = (await services.store.getRun(runId)) as Run;
      stored.repo = { owner: github.owner, name: github.repo, baseBranch: base, defaultBranch: stored.repo?.defaultBranch ?? base };
      await services.store.saveRun(stored);

      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let current = stored;
      let approvedMerge = false;
      while (Date.now() < deadline) {
        const latest = (await services.store.getRun(runId)) as Run;
        if (latest.status === "succeeded" || latest.status === "failed" || latest.status === "cancelled") {
          current = latest;
          break;
        }
        if (latest.tasks.approve_merge.status === "awaiting_approval" && !approvedMerge) {
          const approval = await approveProjectGate(services, runId, "approve_merge", "APPROVE", "owner");
          expect(approval.ok).toBe(true);
          approvedMerge = true;
          continue;
        }
        if (latest.tasks.merge.status === "blocked") {
          // Merging is disabled for this test, so the run must stop here with an explicit reason.
          current = latest;
          break;
        }
        const step = await advanceProjectRun(services, runId, "e2e-test");
        current = step.run;
        console.log(`E2E_STEP ${new Date().toISOString()} ${step.didWork ? "worked" : "idle"}: ${step.message.slice(0, 160)}`);
        if (!step.didWork || (current.status === "waiting" && current.tasks.checks.status === "waiting")) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
      }

      const finalRun = (await services.store.getRun(runId)) as Run;
      branch = finalRun.branch ?? "";
      pullNumber = finalRun.pr?.number ?? 0;
      const evidence = {
        branch: finalRun.branch,
        headSha: finalRun.headSha,
        pullRequest: finalRun.pr?.url,
        checks: finalRun.tasks.checks.evidence.map((item) => `${item.label}: ${item.value}`),
        review: finalRun.tasks.review.evidence.map((item) => `${item.label}: ${item.value}`),
        stop: finalRun.tasks.merge.error ?? finalRun.stopReason ?? finalRun.status,
      };
      console.log("E2E_EVIDENCE " + JSON.stringify(evidence));

      expect(current.tasks.backend.status).toBe("succeeded");
      expect(finalRun.branch).toMatch(/^agent\/[a-z0-9-]+$/);
      expect(finalRun.headSha).toBeTruthy();
      expect(finalRun.pr?.url).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
      expect(finalRun.tasks.checks.status).toBe("succeeded");
      expect(finalRun.tasks.checks.evidence.length).toBeGreaterThan(0);
      expect(finalRun.tasks.merge.status).toBe("blocked");
      expect(finalRun.tasks.merge.error).toContain("Merging is disabled");
      expect(finalRun.tasks.approve_merge.status).toBe("succeeded");
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
