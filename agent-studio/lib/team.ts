import type { EffectiveAgent } from "./registry";
import type { Run } from "./types";
import { TASKS, type RoleId, type TaskId } from "./workflow";

export type TeamStatus = "available" | "configured" | "executed";

export interface RoleDefinition {
  id: RoleId;
  labelKey: string;
  /** What actually performs the work for this role. */
  servedBy: string;
  /** Registry agent ids that are verified for this role (informational; see `adapter`). */
  agentIds: string[];
  requires: { model: boolean; github: boolean };
  adapter: "model" | "deterministic" | "model+deterministic" | "github-ci" | "github-api";
}

/**
 * Twelve logical roles. Only what the app really runs is marked as executed. Verified open-source
 * agents appear with their adapter status so the team board never implies a run that did not happen.
 */
export const TEAM_ROLES: RoleDefinition[] = [
  { id: "pm", labelKey: "role.pm", servedBy: "Project planner (built-in, or the configured model)", agentIds: [], requires: { model: false, github: false }, adapter: "deterministic" },
  { id: "research", labelKey: "role.research", servedBy: "Configured free model (OpenAI-compatible)", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "architect", labelKey: "role.architect", servedBy: "Configured free model (OpenAI-compatible)", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "uiux", labelKey: "role.uiux", servedBy: "Configured free model (OpenAI-compatible)", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "frontend", labelKey: "role.frontend", servedBy: "Model patch adapter committing to the agent branch", agentIds: ["aider", "cline", "qwen-code"], requires: { model: true, github: true }, adapter: "model" },
  { id: "backend", labelKey: "role.backend", servedBy: "Model patch adapter committing to the agent branch", agentIds: ["aider", "cline", "qwen-code"], requires: { model: true, github: true }, adapter: "model" },
  { id: "review", labelKey: "role.review", servedBy: "Deterministic diff scanner, plus the configured model", agentIds: ["gemini-cli", "qwen-code"], requires: { model: false, github: true }, adapter: "model+deterministic" },
  { id: "testing", labelKey: "role.testing", servedBy: "GitHub Actions CI on the agent branch", agentIds: [], requires: { model: false, github: true }, adapter: "github-ci" },
  { id: "debugging", labelKey: "role.debugging", servedBy: "Model patch adapter reading CI and review output", agentIds: ["mini-swe-agent", "open-interpreter"], requires: { model: true, github: true }, adapter: "model" },
  { id: "devops", labelKey: "role.devops", servedBy: "GitHub API for pull requests and merges; Vercel deploy hook and URL check", agentIds: [], requires: { model: false, github: true }, adapter: "github-api" },
  { id: "localization", labelKey: "role.localization", servedBy: "Configured free model, reviewing English and Persian coverage", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "auditor", labelKey: "role.auditor", servedBy: "Separate model call that judges requirements against the diff", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
];

export interface RoleStatusInput {
  modelConfigured: boolean;
  githubConfigured: boolean;
  agents: EffectiveAgent[];
  runs: Run[];
}

export interface RoleSummary {
  id: RoleId;
  labelKey: string;
  servedBy: string;
  adapter: RoleDefinition["adapter"];
  status: TeamStatus;
  requirementsMet: boolean;
  verifiedAgents: { id: string; name: string; enabled: boolean; adapterStatus: string }[];
  executedCount: number;
  lastResult?: { taskId: TaskId; title: string; status: string; at: string; runId: string };
  history: { taskId: TaskId; title: string; status: string; at: string; runId: string }[];
}

function taskRolesOf(run: Run): { taskId: TaskId; role: RoleId; status: string; at: string }[] {
  return run.order.map((taskId) => {
    const def = TASKS.find((item) => item.id === taskId);
    const state = run.tasks[taskId];
    return {
      taskId,
      role: def?.role ?? "pm",
      status: state.status,
      at: state.finishedAt ?? state.updatedAt,
    };
  });
}

export function summarizeTeam(input: RoleStatusInput): RoleSummary[] {
  const records = input.runs.flatMap((run) =>
    taskRolesOf(run).map((item) => ({ ...item, runId: run.id, title: TASKS.find((t) => t.id === item.taskId)?.title.en ?? item.taskId })),
  );
  return TEAM_ROLES.map((role) => {
    const requirementsMet =
      (!role.requires.model || input.modelConfigured) && (!role.requires.github || input.githubConfigured);
    const mine = records.filter((record) => record.role === role.id).sort((a, b) => b.at.localeCompare(a.at));
    const executedCount = mine.filter((record) => record.status === "succeeded").length;
    const status: TeamStatus = executedCount > 0 ? "executed" : requirementsMet ? "configured" : "available";
    const verifiedAgents = input.agents
      .filter((agent) => role.agentIds.includes(agent.id) || agent.roles.includes(role.id))
      .map((agent) => ({ id: agent.id, name: agent.name, enabled: agent.enabled, adapterStatus: agent.adapter.status }));
    const last = mine[0];
    return {
      id: role.id,
      labelKey: role.labelKey,
      servedBy: role.servedBy,
      adapter: role.adapter,
      status,
      requirementsMet,
      verifiedAgents,
      executedCount,
      lastResult: last ? { taskId: last.taskId, title: last.title, status: last.status, at: last.at, runId: last.runId } : undefined,
      history: mine.slice(0, 5).map((record) => ({
        taskId: record.taskId,
        title: record.title,
        status: record.status,
        at: record.at,
        runId: record.runId,
      })),
    };
  });
}
