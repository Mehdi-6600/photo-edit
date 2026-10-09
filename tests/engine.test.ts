import { describe, expect, it } from "vitest";
import {
  MODEL_BLOCKED_MESSAGE,
  acceptBranchHead,
  advanceRun,
  approveGate,
  beginStep,
  cancelRun,
  createRun,
  finishStep,
  pauseRun,
  resumeRun,
  retryTask,
} from "@/lib/engine";
import { analyzeIdeaHeuristic } from "@/lib/planner";
import type { Run } from "@/lib/types";
import { FakeGitHub, FakeModel, FixedClock, makeContext, runSummary } from "./helpers/fakes";

const START = "2026-10-09T10:00:00.000Z";

function newRun(clock: FixedClock, withRepo = true): Run {
  const plan = analyzeIdeaHeuristic("Build a multilingual booking website for a barber shop with login.", clock.now());
  return createRun(plan, {
    id: "r-engine-01",
    now: clock.now(),
    repo: withRepo ? { owner: "octo", name: "demo", baseBranch: "main", defaultBranch: "main" } : undefined,
  });
}

/** Drives a run until it needs the owner or finishes. Approves gates when `approve` is true. */
async function drive(run: Run, ctx: ReturnType<typeof makeContext>, clock: FixedClock, options: { approve?: boolean; maxSteps?: number } = {}) {
  const maxSteps = options.maxSteps ?? 200;
  for (let step = 0; step < maxSteps; step += 1) {
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") break;
    if (options.approve && run.tasks.approve_merge.status === "awaiting_approval") {
      approveGate(run, "approve_merge", "APPROVE", clock.now(), "owner");
    }
    if (options.approve && run.tasks.approve_deploy.status === "awaiting_approval") {
      approveGate(run, "approve_deploy", "DEPLOY", clock.now(), "owner");
    }
    const result = await advanceRun(run, ctx);
    if (!result.didWork) {
      if (run.status === "waiting" && run.order.some((id) => run.tasks[id].status === "blocked")) break;
      if (run.status === "waiting" && run.order.some((id) => run.tasks[id].status === "awaiting_approval") && !options.approve) break;
    }
    clock.advance(60_000);
  }
  return run;
}

describe("delivery engine", () => {
  it("fails closed when the auditor omits a must-have requirement", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const model = new FakeModel();
    model.requirementIds = ["R1"];
    const ctx = makeContext({ clock, github: new FakeGitHub(), model });
    await drive(run, ctx, clock, { approve: true, maxSteps: 80 });
    expect(run.tasks.audit.status).toBe("failed");
    expect(run.tasks.audit.error).toContain("unmet or unverified");
    expect(run.tasks.pr.status).toBe("pending");
  });

  it("blocks note steps honestly when no model is configured", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const ctx = makeContext({ clock, github: new FakeGitHub(), model: null });
    await drive(run, ctx, clock);
    expect(run.tasks.research.status).toBe("blocked");
    expect(run.tasks.research.error).toBe(MODEL_BLOCKED_MESSAGE);
    expect(run.status).toBe("waiting");
    expect(run.stopReason).toContain("AI model is not configured");
  });

  it("redacts configured secrets from stored evidence and step results", () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const secret = "owner-only-private-value-123";
    const ctx = makeContext({ clock, github: new FakeGitHub(), model: new FakeModel(), secrets: [secret] });
    run.tasks.research.status = "running";
    const message = finishStep(
      run,
      "research",
      {
        outcome: "succeeded",
        output: `Probe echoed ${secret}`,
        evidence: [{ label: "Credential", value: `value=${secret}`, url: `https://example.com/${secret}` }],
      },
      ctx,
    );
    const serialized = JSON.stringify({ message, task: run.tasks.research, events: run.events });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("completes the whole flow with approval gates and records evidence", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    const model = new FakeModel();
    const ctx = makeContext({ clock, github, model, allowMerge: false });
    await drive(run, ctx, clock, { approve: true });

    // Merging is disabled, so the engine waits for a manual merge on GitHub.
    expect(run.tasks.merge.status).toBe("blocked");
    expect(run.tasks.merge.error).toContain("Merging is disabled");
    expect(run.pr?.number).toBe(1);
    github.pulls[0].merged = true;
    github.pulls[0].state = "closed";
    await drive(run, ctx, clock, { approve: true });

    expect(run.status).toBe("succeeded");
    expect(runSummary(run)).toContain("verify:succeeded");
    expect(run.approvals.map((item) => item.gate)).toEqual(["approve_merge", "approve_deploy"]);
    expect(run.branch).toMatch(/^agent\/[a-z0-9-]+-[a-z0-9]{6}$/);
    expect(run.branch?.length).toBeLessThanOrEqual(80);
    expect(github.commitMessages.some((message) => message.startsWith("agent(backend):"))).toBe(true);
    expect(github.commitMessages.some((message) => message.startsWith("agent(frontend):"))).toBe(true);
    expect(run.tasks.checks.evidence.some((item) => item.label === "ci")).toBe(true);
  });

  it("blocks a merge when the reviewed pull-request head changes and invalidates approval", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    const ctx = makeContext({ clock, github, model: new FakeModel(), allowMerge: true });
    await drive(run, ctx, clock, { approve: false, maxSteps: 80 });
    expect(run.tasks.approve_merge.status).toBe("awaiting_approval");
    const branch = run.branch as string;
    github.branches.set(branch, "sha-external-change");
    approveGate(run, "approve_merge", "APPROVE", clock.now(), "owner");
    await advanceRun(run, ctx);
    expect(run.tasks.merge.status).toBe("blocked");
    expect(run.tasks.merge.error).toContain("changed outside Agent Studio");
    expect(github.pulls[0].merged).toBe(false);

    acceptBranchHead(run, "sha-external-change", clock.now(), "owner");
    expect(run.tasks.checks.status).toBe("pending");
    expect(run.tasks.review.status).toBe("pending");
    expect(run.tasks.audit.status).toBe("pending");
    expect(run.tasks.approve_merge.status).toBe("pending");
    expect(run.tasks.approve_deploy.status).toBe("pending");
    expect(run.approvals).toHaveLength(0);
  });

  it("never merges or deploys without the typed approval phrase", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const ctx = makeContext({ clock, github: new FakeGitHub(), model: new FakeModel(), allowMerge: true });
    await drive(run, ctx, clock, { approve: false });
    expect(run.tasks.approve_merge.status).toBe("awaiting_approval");
    expect(run.tasks.merge.status).toBe("pending");
    const wrong = approveGate(run, "approve_merge", "yes please", clock.now(), "owner");
    expect(wrong.ok).toBe(false);
    expect(run.tasks.approve_merge.status).toBe("awaiting_approval");
  });

  it("re-runs CI after a failing check through the debugging loop", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    // Commit order: backend (success), frontend (CI fails), debugging fix (CI passes).
    github.checkOutcomes = ["success", "failure", "success"];
    const model = new FakeModel();
    const ctx = makeContext({ clock, github, model });
    await drive(run, ctx, clock, { approve: true, maxSteps: 60 });
    expect(run.tasks.debug.status).toBe("succeeded");
    expect(run.tasks.debug.attempts).toBe(0);
    expect(github.commitMessages.some((message) => message.startsWith("agent(debugging):"))).toBe(true);
    expect(run.tasks.checks.status).toBe("succeeded");
    expect(run.tasks.review.status).toBe("succeeded");
  });

  it("stops after the debugging budget is exhausted", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    github.checkOutcomes = ["failure", "failure", "failure", "failure", "failure", "failure", "failure"];
    const ctx = makeContext({ clock, github, model: new FakeModel() });
    await drive(run, ctx, clock, { approve: true, maxSteps: 120 });
    expect(run.status).toBe("failed");
    expect(run.tasks.checks.status).toBe("failed");
    expect(run.stopReason).toContain("CI failed");
  });

  it("refuses a patch that contains secret-like text and retries later", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    const model = new FakeModel();
    const fakeCredential = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
    model.patchContents = [`export const token = '${fakeCredential}';\n`, "export const ok = true;\n"];
    const ctx = makeContext({ clock, github, model });
    await drive(run, ctx, clock, { approve: true, maxSteps: 80 });
    expect(run.tasks.backend.attempts).toBe(1);
    expect(run.tasks.backend.status).toBe("succeeded");
    expect(model.patchCounter).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify(run);
    expect(everything).not.toContain(fakeCredential);
    expect(github.commits.size).toBeGreaterThan(1);
  });

  it("refuses to commit when a persisted run points at the default branch", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    run.tasks.research.status = "succeeded";
    run.tasks.design.status = "succeeded";
    run.tasks.ux.status = "succeeded";
    run.branch = "main";
    run.baseSha = "sha-0";
    run.headSha = "sha-0";
    const github = new FakeGitHub();
    const model = new FakeModel();
    const result = await advanceRun(run, makeContext({ clock, github, model }));
    expect(result.message).toContain("Agent branches must match agent/<name>");
    expect(run.tasks.backend.status).toBe("ready");
    expect(github.commits.size).toBe(1);
    expect(github.branches.get("main")).toBe("sha-0");
    expect(model.patchCounter).toBe(0);
  });

  it("detects a branch changed outside Agent Studio and waits for the owner", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const github = new FakeGitHub();
    const ctx = makeContext({ clock, github, model: new FakeModel() });
    await drive(run, ctx, clock, { approve: true, maxSteps: 4 });
    const branch = run.branch as string;
    github.branches.set(branch, "sha-someone-else");
    const before = github.commits.size;
    await drive(run, ctx, clock, { approve: true, maxSteps: 8 });
    expect(run.tasks.frontend.status).toBe("blocked");
    expect(run.tasks.frontend.error).toContain("changed outside Agent Studio");
    expect(github.commits.size).toBe(before);
    acceptBranchHead(run, "sha-someone-else", clock.now(), "owner");
    expect(run.headSha).toBe("sha-someone-else");
    expect(run.tasks.frontend.status).toBe("ready");
    expect(run.tasks.checks.status).toBe("pending");
    expect(run.tasks.review.status).toBe("pending");
    expect(run.tasks.audit.status).toBe("pending");
  });

  it("pauses, resumes and cancels without losing task state", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    const ctx = makeContext({ clock, github: new FakeGitHub(), model: new FakeModel() });
    await advanceRun(run, ctx);
    pauseRun(run, clock.now(), "owner");
    expect(run.status).toBe("paused");
    expect(beginStep(run, clock.now()).taskId).toBeNull();
    resumeRun(run, clock.now(), "owner");
    expect(run.status).not.toBe("paused");
    cancelRun(run, clock.now(), "owner");
    expect(run.status).toBe("cancelled");
    expect(run.tasks.design.status).toBe("cancelled");
    expect(run.tasks.research.status).toBe("succeeded");
  });

  it("retry resets failed steps and reopens the run", async () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    run.tasks.research.status = "failed";
    run.tasks.research.error = "boom";
    run.tasks.research.attempts = 2;
    run.status = "failed";
    retryTask(run, undefined, clock.now(), "owner");
    expect(run.tasks.research.status).toBe("ready");
    expect(run.tasks.research.attempts).toBe(0);
    expect(run.status).toBe("running");
  });

  it("keeps the conditional debug step skipped until it is needed", () => {
    const clock = new FixedClock(START);
    const run = newRun(clock);
    expect(run.tasks.debug.status).toBe("skipped");
  });
});
