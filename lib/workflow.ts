/**
 * The delivery workflow is a fixed, reviewed task graph. Models can enrich task
 * notes and requirements, but they cannot change which steps exist or their order.
 */

export const TASK_IDS = [
  "research",
  "design",
  "ux",
  "backend",
  "frontend",
  "i18n",
  "checks",
  "review",
  "debug",
  "audit",
  "pr",
  "approve_merge",
  "merge",
  "approve_deploy",
  "deploy",
  "verify",
] as const;

export type TaskId = (typeof TASK_IDS)[number];

export type RoleId =
  | "pm"
  | "research"
  | "architect"
  | "uiux"
  | "frontend"
  | "backend"
  | "review"
  | "testing"
  | "debugging"
  | "devops"
  | "localization"
  | "auditor"
  | "owner";

export type TaskKind = "note" | "implement" | "checks" | "review" | "debug" | "audit" | "pr" | "gate" | "merge" | "deploy" | "verify";

export interface TaskDef {
  id: TaskId;
  role: RoleId;
  kind: TaskKind;
  title: { en: string; fa: string };
  summary: string;
  dependsOn: TaskId[];
  maxAttempts: number;
  /** Maximum status polls for tasks that wait on external systems. */
  maxPolls?: number;
  /** Runs only when triggered by a failure elsewhere (see engine). */
  conditional?: boolean;
}

export const TASKS: readonly TaskDef[] = [
  {
    id: "research",
    role: "research",
    kind: "note",
    title: { en: "Research options", fa: "بررسی گزینه‌ها" },
    summary: "Compare relevant libraries, hosting options and documentation, and list the sources you relied on.",
    dependsOn: [],
    maxAttempts: 2,
  },
  {
    id: "design",
    role: "architect",
    kind: "note",
    title: { en: "Architecture and data model", fa: "معماری و مدل داده" },
    summary: "Write the architecture note: routes, data model, module boundaries and risks.",
    dependsOn: ["research"],
    maxAttempts: 2,
  },
  {
    id: "ux",
    role: "uiux",
    kind: "note",
    title: { en: "Mobile user flows", fa: "جریان‌های کاربری موبایل" },
    summary: "Define the screens, user flows and touch-friendly layout for small screens.",
    dependsOn: ["design"],
    maxAttempts: 2,
  },
  {
    id: "backend",
    role: "backend",
    kind: "implement",
    title: { en: "Backend implementation", fa: "پیاده‌سازی بک‌اند" },
    summary: "Implement API routes, business logic and input validation. Commit the changes to the agent branch.",
    dependsOn: ["design"],
    maxAttempts: 2,
  },
  {
    id: "frontend",
    role: "frontend",
    kind: "implement",
    title: { en: "Frontend implementation", fa: "پیاده‌سازی رابط کاربری" },
    summary: "Implement responsive screens for the flows. Commit the changes to the agent branch.",
    dependsOn: ["ux", "backend"],
    maxAttempts: 2,
  },
  {
    id: "i18n",
    role: "localization",
    kind: "note",
    title: { en: "Localization and RTL check", fa: "بررسی ترجمه و چیدمان راست‌به‌چپ" },
    summary: "Check English and Persian coverage and right-to-left layout for the changed files.",
    dependsOn: ["frontend"],
    maxAttempts: 2,
  },
  {
    id: "checks",
    role: "testing",
    kind: "checks",
    title: { en: "CI checks", fa: "بررسی‌های CI" },
    summary: "Wait for GitHub Actions checks (type check, tests, build) on the agent branch head.",
    dependsOn: ["i18n"],
    maxAttempts: 3,
    maxPolls: 60,
  },
  {
    id: "debug",
    role: "debugging",
    kind: "debug",
    title: { en: "Debug and fix failures", fa: "اشکال‌زدایی و رفع خطاها" },
    summary: "Read the failing check or review output and commit the smallest fix that addresses it.",
    dependsOn: [],
    maxAttempts: 3,
    conditional: true,
  },
  {
    id: "review",
    role: "review",
    kind: "review",
    title: { en: "Code review and security scan", fa: "بازبینی کد و اسکن امنیتی" },
    summary: "Scan the diff for secrets, protected paths and risky patterns, then review quality.",
    dependsOn: ["checks"],
    maxAttempts: 3,
  },
  {
    id: "audit",
    role: "auditor",
    kind: "audit",
    title: { en: "Independent requirement audit", fa: "ممیزی مستقل نیازمندی‌ها" },
    summary: "Map each requirement to evidence in the diff. Report unmet requirements instead of assuming them.",
    dependsOn: ["review"],
    maxAttempts: 1,
  },
  {
    id: "pr",
    role: "devops",
    kind: "pr",
    title: { en: "Open pull request", fa: "باز کردن درخواست ادغام" },
    summary: "Open or reuse a pull request from the agent branch into the base branch.",
    dependsOn: ["audit"],
    maxAttempts: 3,
  },
  {
    id: "approve_merge",
    role: "owner",
    kind: "gate",
    title: { en: "Your approval to merge", fa: "تأیید شما برای ادغام" },
    summary: "Owner approval gate. Merging requires APPROVE; if Vercel auto-deploys the production branch on merge, this approval also precedes that deployment.",
    dependsOn: ["pr"],
    maxAttempts: 1,
  },
  {
    id: "merge",
    role: "devops",
    kind: "merge",
    title: { en: "Merge pull request", fa: "ادغام درخواست" },
    summary: "Merge the approved pull request when merging is enabled, or detect a merge done on GitHub.",
    dependsOn: ["approve_merge"],
    maxAttempts: 2,
  },
  {
    id: "approve_deploy",
    role: "owner",
    kind: "gate",
    title: { en: "Your approval to deploy", fa: "تأیید شما برای استقرار" },
    summary: "Owner approval gate before the configured deploy hook; Vercel Git may already have deployed after the APPROVE-authorized merge.",
    dependsOn: ["merge"],
    maxAttempts: 1,
  },
  {
    id: "deploy",
    role: "devops",
    kind: "deploy",
    title: { en: "Trigger deployment", fa: "شروع استقرار" },
    summary: "Trigger the configured Vercel deploy hook after approval.",
    dependsOn: ["approve_deploy"],
    maxAttempts: 2,
  },
  {
    id: "verify",
    role: "devops",
    kind: "verify",
    title: { en: "Verify production URL", fa: "بررسی آدرس تولید" },
    summary: "Request the production URL and confirm it serves an HTML page with HTTP 200.",
    dependsOn: ["deploy"],
    maxAttempts: 1,
    maxPolls: 20,
  },
];

export const TASK_BY_ID: Readonly<Record<TaskId, TaskDef>> = Object.fromEntries(
  TASKS.map((task) => [task.id, task]),
) as Record<TaskId, TaskDef>;

/** Failure of a key task starts the debug loop; success of debug re-opens these tasks. */
export const DEBUG_TRIGGERS: readonly TaskId[] = ["checks", "review"];
export const DEBUG_RESETS: Readonly<Partial<Record<TaskId, "ready" | "pending">>> = {
  checks: "ready",
  review: "pending",
};

/** Approval phrases the owner must type exactly for each gate. */
export const GATE_PHRASES: Readonly<Partial<Record<TaskId, string>>> = {
  approve_merge: "APPROVE",
  approve_deploy: "DEPLOY",
};

export function validateWorkflow(tasks: readonly TaskDef[] = TASKS): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id} depends on unknown task ${dep}`);
    }
  }
  // Kahn's algorithm: an acyclic graph consumes every node.
  const indegree = new Map<string, number>(tasks.map((task) => [task.id, task.dependsOn.length]));
  const queue = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;
    for (const task of tasks) {
      if (task.dependsOn.includes(current as TaskId)) {
        const next = (indegree.get(task.id) ?? 0) - 1;
        indegree.set(task.id, next);
        if (next === 0) queue.push(task.id);
      }
    }
  }
  if (visited !== tasks.length) throw new Error("The workflow graph contains a cycle.");
}

/** Topological order of the task list (stable with respect to the declaration order). */
export function workflowOrder(tasks: readonly TaskDef[] = TASKS): TaskId[] {
  validateWorkflow(tasks);
  const done = new Set<TaskId>();
  const order: TaskId[] = [];
  while (order.length < tasks.length) {
    for (const task of tasks) {
      if (done.has(task.id)) continue;
      if (task.dependsOn.every((dep) => done.has(dep))) {
        done.add(task.id);
        order.push(task.id);
      }
    }
  }
  return order;
}
