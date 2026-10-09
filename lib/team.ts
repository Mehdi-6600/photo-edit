import type { EffectiveAgent } from "./registry";
import type { DictKey } from "./i18n";
import type { Run, TaskStatus } from "./types";
import { TASKS, type RoleId, type TaskId } from "./workflow";

export type TeamStatus = "available" | "configured" | "executed";

export interface RoleDefinition {
  id: RoleId;
  labelKey: DictKey;
  /** Translation key describing the adapter that actually performs the work. */
  servedByKey: DictKey;
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
  { id: "pm", labelKey: "role.pm", servedByKey: "team.served.pm", agentIds: [], requires: { model: false, github: false }, adapter: "deterministic" },
  { id: "research", labelKey: "role.research", servedByKey: "team.served.research", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "architect", labelKey: "role.architect", servedByKey: "team.served.architect", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "uiux", labelKey: "role.uiux", servedByKey: "team.served.uiux", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "frontend", labelKey: "role.frontend", servedByKey: "team.served.frontend", agentIds: ["aider", "cline", "qwen-code"], requires: { model: true, github: true }, adapter: "model" },
  { id: "backend", labelKey: "role.backend", servedByKey: "team.served.backend", agentIds: ["aider", "cline", "qwen-code"], requires: { model: true, github: true }, adapter: "model" },
  { id: "review", labelKey: "role.review", servedByKey: "team.served.review", agentIds: ["gemini-cli", "qwen-code"], requires: { model: false, github: true }, adapter: "model+deterministic" },
  { id: "testing", labelKey: "role.testing", servedByKey: "team.served.testing", agentIds: [], requires: { model: false, github: true }, adapter: "github-ci" },
  { id: "debugging", labelKey: "role.debugging", servedByKey: "team.served.debugging", agentIds: ["mini-swe-agent", "open-interpreter"], requires: { model: true, github: true }, adapter: "model" },
  { id: "devops", labelKey: "role.devops", servedByKey: "team.served.devops", agentIds: [], requires: { model: false, github: true }, adapter: "github-api" },
  { id: "localization", labelKey: "role.localization", servedByKey: "team.served.localization", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
  { id: "auditor", labelKey: "role.auditor", servedByKey: "team.served.auditor", agentIds: [], requires: { model: true, github: false }, adapter: "model" },
];

export interface RoleStatusInput {
  modelConfigured: boolean;
  githubConfigured: boolean;
  agents: EffectiveAgent[];
  runs: Run[];
}

export interface RoleSummary {
  id: RoleId;
  labelKey: DictKey;
  servedByKey: DictKey;
  adapter: RoleDefinition["adapter"];
  status: TeamStatus;
  requirementsMet: boolean;
  verifiedAgents: { id: string; name: string; enabled: boolean; adapterStatus: string }[];
  executedCount: number;
  lastResult?: { taskId: TaskId; status: TaskStatus; at: string; runId: string };
  history: { taskId: TaskId; status: TaskStatus; at: string; runId: string }[];
}

function taskRolesOf(run: Run): { taskId: TaskId; role: RoleId; status: TaskStatus; at: string }[] {
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
  const records = input.runs.flatMap((run) => taskRolesOf(run).map((item) => ({ ...item, runId: run.id })));
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
      servedByKey: role.servedByKey,
      adapter: role.adapter,
      status,
      requirementsMet,
      verifiedAgents,
      executedCount,
      lastResult: last ? { taskId: last.taskId, status: last.status, at: last.at, runId: last.runId } : undefined,
      history: mine.slice(0, 5).map((record) => ({
        taskId: record.taskId,
        status: record.status,
        at: record.at,
        runId: record.runId,
      })),
    };
  });
}
