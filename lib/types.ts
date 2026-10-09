import type { Lang } from "./i18n";
import type { TaskId } from "./workflow";

export type Priority = "must" | "should" | "could";

export interface Requirement {
  id: string;
  text: string;
  priority: Priority;
  acceptance: string[];
}

export interface Plan {
  title: string;
  summary: string;
  idea: string;
  language: Lang;
  assumptions: string[];
  questions: string[];
  requirements: Requirement[];
  features: string[];
  taskNotes: Partial<Record<TaskId, string>>;
  planner: {
    mode: "heuristic" | "model";
    model?: string;
    warnings: string[];
  };
  createdAt: string;
}

export type RunStatus = "running" | "waiting" | "paused" | "succeeded" | "failed" | "cancelled";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "held"
  | "blocked"
  | "awaiting_approval"
  | "succeeded"
  | "skipped"
  | "failed"
  | "cancelled";

export interface Evidence {
  label: string;
  value: string;
  url?: string;
}

export interface TaskState {
  status: TaskStatus;
  attempts: number;
  polls: number;
  nextAttemptAt?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  output?: string;
  error?: string;
  evidence: Evidence[];
}

export interface RunEvent {
  id: string;
  at: string;
  level: "info" | "success" | "warn" | "error";
  actor: string;
  taskId?: TaskId;
  message: string;
}

export interface RunRepo {
  owner: string;
  name: string;
  baseBranch: string;
  defaultBranch: string;
}

export interface Approval {
  gate: TaskId;
  at: string;
  by: string;
}

export interface Run {
  id: string;
  version: number;
  title: string;
  idea: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  plan: Plan;
  order: TaskId[];
  tasks: Record<TaskId, TaskState>;
  events: RunEvent[];
  repo?: RunRepo;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  pr?: { number: number; url: string; state: "open" | "closed" | "merged" };
  approvals: Approval[];
  stopReason?: string;
}
