import { triggerDeployHook, verifyProductionUrl } from "./deploy";
import {
  type DeployPort,
  type EngineContext,
  type StepOutcome,
  acceptBranchHead,
  approveGate,
  beginStep,
  cancelRun,
  createRun,
  createRunId,
  executeTask,
  finishStep,
  log,
  pauseRun,
  resumeRun,
  retryTask,
} from "./engine";
import { GitHubClient, parseRepoSlug } from "./github";
import { type ChatPort, ModelClient, type ModelConfig, modelConfigFromEnv } from "./model";
import { type EnvLike, type PathPolicy, isStrongAccessToken, parseAllowedPaths } from "./security";
import { type AuditEntry, ConflictError, type StudioStore, createStoreFromEnv } from "./store";
import type { Plan, Run, RunRepo } from "./types";
import { GATE_PHRASES, TASK_BY_ID, type TaskId } from "./workflow";

export const REPO_SETTING_KEY = "settings:github-repository";

export interface StudioConfig {
  accessToken?: string;
  githubToken?: string;
  githubRepository?: { owner: string; name: string };
  model: ModelConfig | null;
  modelConfigError?: string;
  vercel: { token?: string; projectId?: string; teamId?: string; hookUrl?: string };
  productionUrl?: string;
  allowMerge: boolean;
  pathPolicy: PathPolicy;
  author: { name: string; email: string };
  secrets: string[];
}

export class NotFoundError extends Error {}
export class InvalidActionError extends Error {}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readConfig(env: EnvLike = process.env): StudioConfig {
  let model: ModelConfig | null = null;
  let modelConfigError: string | undefined;
  try {
    model = modelConfigFromEnv(env);
  } catch (error) {
    modelConfigError = (error as Error).message;
  }
  const slug = parseRepoSlug(clean(env.GITHUB_REPOSITORY));
  return {
    accessToken: clean(env.APP_ACCESS_TOKEN),
    githubToken: clean(env.GITHUB_TOKEN),
    githubRepository: slug ? { owner: slug.owner, name: slug.name } : undefined,
    model,
    modelConfigError,
    vercel: {
      token: clean(env.VERCEL_TOKEN),
      projectId: clean(env.VERCEL_PROJECT_ID),
      teamId: clean(env.VERCEL_TEAM_ID),
      hookUrl: clean(env.VERCEL_DEPLOY_HOOK_URL),
    },
    productionUrl: clean(env.PRODUCTION_URL),
    allowMerge: env.AGENT_STUDIO_ALLOW_MERGE === "true",
    pathPolicy: {
      allow: parseAllowedPaths(env.AGENT_ALLOWED_PATHS),
      maxFiles: 6,
      maxBytesPerFile: 60_000,
    },
    author: {
      name: clean(env.AGENT_GIT_AUTHOR_NAME) ?? "agent-studio[bot]",
      email: clean(env.AGENT_GIT_AUTHOR_EMAIL) ?? "agent-studio@users.noreply.github.com",
    },
    // Exact values that must never appear in logs, errors or stored events.
    secrets: [
      clean(env.APP_ACCESS_TOKEN),
      clean(env.GITHUB_TOKEN),
      clean(env.LLM_API_KEY),
      clean(env.VERCEL_TOKEN),
      clean(env.VERCEL_DEPLOY_HOOK_URL),
      clean(env.UPSTASH_REDIS_REST_TOKEN),
    ].filter((value): value is string => Boolean(value)),
  };
}

export interface Services {
  config: StudioConfig;
  store: StudioStore;
  now: () => Date;
  model: ChatPort | null;
  deploy: DeployPort;
  /** Repository chosen in the UI (stored) or configured by environment. */
  repository(): Promise<{ owner: string; name: string } | null>;
  githubFor(owner: string, name: string): GitHubClient | null;
  audit(entry: Omit<AuditEntry, "at">): Promise<void>;
}

export function createServices(config: StudioConfig, store: StudioStore, now: () => Date = () => new Date()): Services {
  const model = config.model ? new ModelClient(config.model) : null;
  const deploy: DeployPort = {
    productionUrl: config.productionUrl,
    hookUrl: config.vercel.hookUrl,
    verify: (url) => verifyProductionUrl(url),
    triggerHook: (url) => triggerDeployHook(url),
  };
  return {
    config,
    store,
    now,
    model,
    deploy,
    async repository() {
      const stored = await store.getValue<{ owner: string; name: string }>(REPO_SETTING_KEY);
      if (stored && parseRepoSlug(`${stored.owner}/${stored.name}`)) return stored;
      return config.githubRepository ?? null;
    },
    githubFor(owner, name) {
      if (!config.githubToken) return null;
      return new GitHubClient(config.githubToken, owner, name);
    },
    async audit(entry) {
      await store.appendAudit({ at: now().toISOString(), ...entry });
    },
  };
}

let singleton: Services | null = null;

export function getServices(): Services {
  if (!singleton) {
    singleton = createServices(readConfig(), createStoreFromEnv());
  }
  return singleton;
}

/** Test seam: replaces the singleton. */
export function setServicesForTests(services: Services | null): void {
  singleton = services;
}

export function accessConfigured(services: Services): boolean {
  return isStrongAccessToken(services.config.accessToken);
}

export function engineContextFor(services: Services, run: Run, actor: string): EngineContext {
  const github = run.repo ? services.githubFor(run.repo.owner, run.repo.name) : null;
  return {
    now: services.now,
    github,
    model: services.model,
    deploy: services.deploy,
    allowMerge: services.config.allowMerge,
    pathPolicy: services.config.pathPolicy,
    author: services.config.author,
    secrets: services.config.secrets,
    actor,
  };
}

/* ----------------------------------------------------------- run flow */

export async function createProjectRun(services: Services, plan: Plan): Promise<Run> {
  const now = services.now();
  const repository = await services.repository();
  let repo: RunRepo | undefined;
  const warnings: string[] = [];
  if (repository) {
    const github = services.githubFor(repository.owner, repository.name);
    if (github) {
      try {
        const info = await github.getRepo();
        repo = {
          owner: repository.owner,
          name: repository.name,
          baseBranch: info.defaultBranch,
          defaultBranch: info.defaultBranch,
        };
        if (!info.permissions.push) warnings.push("The token cannot push to this repository, so agent branches cannot be created.");
      } catch (error) {
        warnings.push(`Repository check failed: ${(error as Error).message}`);
      }
    } else {
      warnings.push("GitHub token is not configured, so code steps are blocked until it is added.");
    }
  }
  const run = createRun(plan, { id: createRunId(), now, repo });
  for (const warning of warnings) log(run, now, "warn", "system", warning);
  if (!repo) {
    log(run, now, "warn", "system", "No repository connected yet. Planning and review can run; code steps wait for GitHub.");
  }
  await services.store.saveRun(run);
  await services.audit({ actor: "owner", action: "run.create", target: run.id, result: "ok", detail: plan.title.slice(0, 120) });
  return run;
}

/**
 * Persists the outcome of an executed step. If another request changed the run meanwhile,
 * the artifacts created on GitHub (branch, head commit, pull request) are carried forward so
 * nothing that was pushed is lost, and the outcome is re-applied only if the step is still running.
 */
async function persistFinishedStep(
  services: Services,
  executed: Run,
  taskId: TaskId,
  outcome: StepOutcome,
  ctx: EngineContext,
): Promise<{ run: Run; message: string }> {
  let candidate = executed;
  let message = finishStep(candidate, taskId, outcome, ctx);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await services.store.saveRun(candidate);
      return { run: candidate, message };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const latest = await services.store.getRun(executed.id);
      if (!latest) throw error;
      latest.branch = executed.branch ?? latest.branch;
      latest.baseSha = executed.baseSha ?? latest.baseSha;
      latest.headSha = executed.headSha ?? latest.headSha;
      latest.pr = executed.pr ?? latest.pr;
      latest.repo = executed.repo ?? latest.repo;
      if (latest.tasks[taskId].status === "running") {
        message = finishStep(latest, taskId, outcome, ctx);
      }
      candidate = latest;
    }
  }
  throw new Error("The run was changed by several requests at once. Reload the page and try again.");
}

export async function advanceProjectRun(
  services: Services,
  runId: string,
  actor: string,
): Promise<{ run: Run; didWork: boolean; message: string }> {
  const run = await services.store.getRun(runId);
  if (!run) throw new NotFoundError("Run not found.");
  const started = beginStep(run, services.now());
  if (!started.taskId) {
    await services.store.saveRun(run);
    return { run, didWork: false, message: started.message };
  }
  const taskId = started.taskId;
  // Persist "running" before any side effect, so a concurrent request cannot start the same step.
  await services.store.saveRun(run);

  const ctx = engineContextFor(services, run, actor);
  let outcome: StepOutcome;
  try {
    outcome = await executeTask(taskId, run, ctx);
  } catch (error) {
    outcome = { outcome: "failed", error: (error as Error).message || "Unexpected error." };
  }
  const { run: saved, message } = await persistFinishedStep(services, run, taskId, outcome, ctx);
  await services.audit({
    actor,
    action: `task.${taskId}`,
    target: saved.id,
    result: outcome.outcome === "failed" ? "error" : "ok",
    detail: message.slice(0, 200),
  });
  return { run: saved, didWork: true, message };
}

export async function controlProjectRun(
  services: Services,
  runId: string,
  action: "pause" | "resume" | "cancel" | "retry" | "accept_head",
  taskId: TaskId | undefined,
  actor: string,
): Promise<Run> {
  const run = await services.store.getRun(runId);
  if (!run) throw new NotFoundError("Run not found.");
  const now = services.now();
  switch (action) {
    case "pause":
      pauseRun(run, now, actor);
      break;
    case "resume":
      resumeRun(run, now, actor);
      break;
    case "cancel":
      cancelRun(run, now, actor);
      break;
    case "retry":
      retryTask(run, taskId, now, actor);
      break;
    case "accept_head": {
      if (!run.branch || !run.repo) throw new InvalidActionError("There is no agent branch to accept yet.");
      const github = services.githubFor(run.repo.owner, run.repo.name);
      if (!github) throw new InvalidActionError("GitHub is not connected.");
      const live = await github.getBranchSha(run.branch);
      if (!live) throw new InvalidActionError("The agent branch no longer exists.");
      acceptBranchHead(run, live, now, actor);
      break;
    }
  }
  await services.store.saveRun(run);
  await services.audit({ actor, action: `run.${action}`, target: runId, result: "ok", detail: taskId });
  return run;
}

export async function approveProjectGate(
  services: Services,
  runId: string,
  gate: TaskId,
  phrase: string,
  actor: string,
): Promise<{ ok: boolean; message: string; run: Run }> {
  const run = await services.store.getRun(runId);
  if (!run) throw new NotFoundError("Run not found.");
  if (!GATE_PHRASES[gate]) throw new InvalidActionError("This step is not an approval gate.");
  const result = approveGate(run, gate, phrase, services.now(), actor);
  if (result.ok) await services.store.saveRun(run);
  await services.audit({
    actor,
    action: `approval.${gate}`,
    target: runId,
    result: result.ok ? "ok" : "denied",
    detail: TASK_BY_ID[gate].title.en,
  });
  return { ...result, run };
}
