import type { Run, TaskStatus } from "./types";
import { TASK_BY_ID, type TaskId } from "./workflow";

const DONE: TaskStatus[] = ["succeeded", "skipped"];
const ATTENTION: TaskStatus[] = ["running", "ready", "waiting", "blocked", "awaiting_approval", "failed", "held"];

export interface RunSummary {
  id: string;
  title: string;
  status: Run["status"];
  createdAt: string;
  updatedAt: string;
  progress: { done: number; total: number };
  current: { taskId: TaskId; status: TaskStatus; error?: string } | null;
  repo: string | null;
  branch: string | null;
  pr: { number: number; url: string; state: string } | null;
  stopReason: string | null;
  approvalNeeded: TaskId | null;
}

export function summarizeRun(run: Run): RunSummary {
  const total = run.order.filter((id) => !(TASK_BY_ID[id].conditional && DONE.includes(run.tasks[id].status) && run.tasks[id].attempts === 0)).length;
  const done = run.order.filter((id) => DONE.includes(run.tasks[id].status) && !(TASK_BY_ID[id].conditional && run.tasks[id].status === "skipped")).length;
  const currentId = run.order.find((id) => ATTENTION.includes(run.tasks[id].status));
  const approval = run.order.find((id) => run.tasks[id].status === "awaiting_approval") ?? null;
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progress: { done, total },
    current: currentId
      ? { taskId: currentId, status: run.tasks[currentId].status, error: run.tasks[currentId].error }
      : null,
    repo: run.repo ? `${run.repo.owner}/${run.repo.name}` : null,
    branch: run.branch ?? null,
    pr: run.pr ? { number: run.pr.number, url: run.pr.url, state: run.pr.state } : null,
    stopReason: run.stopReason ?? null,
    approvalNeeded: approval,
  };
}
