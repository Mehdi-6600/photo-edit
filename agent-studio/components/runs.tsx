"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Heading, Notice, ProgressBar, Spinner, StatusChip, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import type { RunSummary } from "@/lib/views";
import type { Run, TaskState } from "@/lib/types";
import { GATE_PHRASES, TASK_BY_ID, TASK_IDS, type TaskId } from "@/lib/workflow";

/* ------------------------------------------------------------- list */

export function RunList() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<{ storage: string; runs: RunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiRequest<{ storage: string; runs: RunSummary[] }>("/api/runs")
        .then((result) => {
          if (alive) {
            setData(result);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof ApiError ? err.message : t("err.generic"));
        });
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [t]);

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("runs.title")} />
      {data?.storage === "memory" ? <Notice tone="warning">{t("common.storageEphemeral")}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!data && !error ? <Spinner label={t("common.loading")} /> : null}
      {data && data.runs.length === 0 ? (
        <Card>
          <p className="text-[var(--muted)]">{t("runs.empty")}</p>
          <Link href="/" className="btn btn-primary mt-4 btn-block no-underline">
            {t("nav.workspace")}
          </Link>
        </Card>
      ) : null}
      <ul className="flex flex-col gap-3">
        {data?.runs.map((run) => (
          <li key={run.id}>
            <Card as="article" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="min-w-0 text-lg font-semibold">{run.title}</h2>
                <StatusChip status={run.status} />
              </div>
              <ProgressBar value={run.progress.done} max={run.progress.total} label={t("runs.progress", { done: run.progress.done, total: run.progress.total })} />
              <p className="text-sm text-[var(--muted)]">
                {t("runs.progress", { done: run.progress.done, total: run.progress.total })} ·{" "}
                {relativeTime(run.updatedAt, lang)}
              </p>
              {run.stopReason ? <p className="text-sm text-[var(--warning)]">{run.stopReason}</p> : null}
              <Link href={`/runs/${run.id}`} className="btn btn-secondary btn-block no-underline">
                {t("runs.open")}
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------- detail */

type Tab = "tasks" | "timeline" | "review" | "logs";

function canAutoContinue(run: Run): boolean {
  if (run.status !== "running" && run.status !== "waiting") return false;
  return !TASK_IDS.some((id) => ["blocked", "awaiting_approval", "failed"].includes(run.tasks[id].status));
}

function nextDelayMs(run: Run): number {
  const now = Date.now();
  const times = TASK_IDS.map((id) => run.tasks[id].nextAttemptAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value) - now)
    .filter((value) => value > 0);
  if (times.length === 0) return 900;
  return Math.min(Math.max(...[Math.min(...times), 1000]), 30000);
}

export function RunDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const [run, setRun] = useState<Run | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const messageOf = useCallback((err: unknown) => (err instanceof ApiError ? err.message : t("err.generic")), [t]);

  const refresh = useCallback(async () => {
    try {
      const data = await apiRequest<{ run: Run }>(`/api/runs/${id}`);
      setRun(data.run);
      setLoadError(null);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  }, [id, messageOf]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const status = run?.status;
  useEffect(() => {
    if (status !== "running" && status !== "waiting") return;
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [status, refresh]);

  const step = useCallback(async () => {
    setActionError(null);
    try {
      const data = await apiRequest<{ run: Run; message: string }>(`/api/runs/${id}/advance`, { body: {} });
      setRun(data.run);
      setMessage(data.message);
    } catch (err) {
      setActionError(messageOf(err));
      setAuto(false);
    }
  }, [id, messageOf]);

  useEffect(() => {
    if (!auto || !run || busy) return;
    if (!canAutoContinue(run)) {
      setAuto(false);
      return;
    }
    const timer = setTimeout(() => {
      setBusy("auto");
      void step().finally(() => setBusy(null));
    }, nextDelayMs(run));
    return () => clearTimeout(timer);
  }, [auto, run, busy, step]);

  async function control(action: "pause" | "resume" | "cancel" | "retry" | "accept_head") {
    if (action === "cancel" && !window.confirm(t("run.cancelConfirm"))) return;
    setBusy(action);
    setActionError(null);
    try {
      const data = await apiRequest<{ run: Run }>(`/api/runs/${id}/control`, { body: { action } });
      setRun(data.run);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError && !run) return <Notice tone="danger">{loadError}</Notice>;
  if (!run) return <Spinner label={t("common.loading")} />;

  const finished = run.status === "succeeded" || run.status === "cancelled";
  const done = TASK_IDS.filter((taskId) => ["succeeded", "skipped"].includes(run.tasks[taskId].status)).length;
  const visibleTasks = run.order.filter((taskId) => !(TASK_BY_ID[taskId].conditional && run.tasks[taskId].status === "skipped"));
  const pending = TASK_IDS.filter((taskId) => run.tasks[taskId].status === "awaiting_approval");
  const repoUrl = run.repo ? `https://github.com/${run.repo.owner}/${run.repo.name}` : null;

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="min-w-0 text-xl font-semibold leading-snug sm:text-2xl">{run.title}</h1>
          <StatusChip status={run.status} />
        </div>
        <ProgressBar value={done} max={visibleTasks.length} label={t("runs.progress", { done, total: visibleTasks.length })} />
        <p className="text-sm text-[var(--muted)]">{t("runs.progress", { done, total: visibleTasks.length })}</p>
        {run.status === "succeeded" ? <Notice tone="success">{t("run.succeeded")}</Notice> : null}
        {run.status === "failed" ? <Notice tone="danger">{t("run.failed")}</Notice> : null}
        {run.status === "paused" ? <Notice tone="neutral">{t("run.paused")}</Notice> : null}
        {run.status === "cancelled" ? <Notice tone="neutral">{t("run.cancelled")}</Notice> : null}
        {run.status === "waiting" || run.status === "running" ? (
          <p className="text-sm text-[var(--muted)]">{t("run.waitingHint")}</p>
        ) : null}
        {run.stopReason && (run.status === "waiting" || run.status === "failed") ? (
          <Notice tone={run.status === "failed" ? "danger" : "warning"}>
            <strong>{t("run.stopReason")}: </strong>
            {run.stopReason}
          </Notice>
        ) : null}
        {message ? <p className="text-sm text-[var(--muted)]">{message}</p> : null}
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
        {loadError ? <Notice tone="warning">{loadError}</Notice> : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="primary" onClick={() => { setBusy("advance"); void step().finally(() => setBusy(null)); }} disabled={busy !== null || finished || run.status === "paused"}>
            {busy === "advance" ? <Spinner label={t("common.loading")} /> : t("run.next")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setAuto((value) => !value)}
            disabled={finished || run.status === "paused"}
            aria-pressed={auto}
          >
            {auto ? t("run.autoStop") : t("run.auto")}
          </Button>
          {run.status === "paused" ? (
            <Button variant="secondary" onClick={() => control("resume")} disabled={busy !== null}>
              {t("run.resume")}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => control("pause")} disabled={busy !== null || finished}>
              {t("run.pause")}
            </Button>
          )}
          {run.tasks.checks.status === "failed" || TASK_IDS.some((taskId) => run.tasks[taskId].status === "failed" || run.tasks[taskId].status === "blocked") ? (
            <Button variant="secondary" onClick={() => control("retry")} disabled={busy !== null}>
              {t("run.retry")}
            </Button>
          ) : null}
          {run.stopReason?.includes("changed outside") ? (
            <Button variant="secondary" onClick={() => control("accept_head")} disabled={busy !== null}>
              {t("run.acceptHead")}
            </Button>
          ) : null}
          {!finished ? (
            <Button variant="danger" onClick={() => control("cancel")} disabled={busy !== null}>
              {t("run.cancel")}
            </Button>
          ) : null}
        </div>
      </Card>

      {pending.map((gate) => (
        <ApprovalCard key={gate} runId={id} gate={gate} onDone={setRun} />
      ))}

      <div role="tablist" aria-label={t("run.tab.tasks")} className="flex gap-1 overflow-x-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-1">
        {(["tasks", "timeline", "review", "logs"] as Tab[]).map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            aria-selected={tab === item}
            className={`tab whitespace-nowrap ${tab === item ? "tab-active" : ""}`}
            onClick={() => setTab(item)}
          >
            {t(`run.tab.${item}` as const)}
          </button>
        ))}
      </div>

      {tab === "tasks" ? (
        <ol className="flex flex-col gap-3">
          {visibleTasks.map((taskId) => (
            <TaskItem key={taskId} taskId={taskId} state={run.tasks[taskId]} lang={lang} t={t} />
          ))}
        </ol>
      ) : null}

      {tab === "timeline" ? (
        <Card className="flex flex-col gap-3">
          {run.events.length === 0 ? <p className="text-[var(--muted)]">{t("run.noEvents")}</p> : null}
          <ol className="flex flex-col gap-3">
            {[...run.events].reverse().slice(0, 200).map((event) => (
              <li key={event.id} className="border-s-2 border-[var(--line)] ps-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
                  <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(lang === "fa" ? "fa-IR" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <Chip tone={event.level === "error" ? "danger" : event.level === "warn" ? "warning" : event.level === "success" ? "success" : "neutral"}>{event.level}</Chip>
                  {event.taskId ? <span>{TASK_BY_ID[event.taskId].title[lang]}</span> : null}
                </div>
                <p className="mt-1 break-words">{event.message}</p>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {tab === "review" ? <ReviewPanel runId={id} run={run} /> : null}

      {tab === "logs" ? (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-[var(--muted)]">{t("common.untrusted")}</p>
          <details>
            <summary>{t("common.details")}</summary>
            <pre className="mono mt-2">{JSON.stringify(run.events.slice(-100), null, 2)}</pre>
          </details>
          <details>
            <summary>{t("run.taskState")}</summary>
            <pre className="mono mt-2">{JSON.stringify(run.tasks, null, 2)}</pre>
          </details>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("run.links")}</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {run.pr ? (
            <li>
              {t("run.link.pr")}:{" "}
              <a href={run.pr.url} target="_blank" rel="noopener noreferrer">
                #{run.pr.number} ({run.pr.state})
              </a>
            </li>
          ) : null}
          {run.branch && repoUrl ? (
            <li>
              {t("run.link.branch")}:{" "}
              <a href={`${repoUrl}/tree/${run.branch}`} target="_blank" rel="noopener noreferrer">
                {run.branch}
              </a>
            </li>
          ) : null}
          {repoUrl ? (
            <li>
              {t("run.link.repo")}:{" "}
              <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                {run.repo?.owner}/{run.repo?.name}
              </a>
            </li>
          ) : null}
          {!run.pr && !run.branch && !repoUrl ? <li className="text-[var(--muted)]">{t("run.link.none")}</li> : null}
        </ul>
      </Card>
    </div>
  );
}

function TaskItem({
  taskId,
  state,
  lang,
  t,
}: {
  taskId: TaskId;
  state: TaskState;
  lang: "en" | "fa";
  t: ReturnType<typeof useI18n>["t"];
}) {
  const def = TASK_BY_ID[taskId];
  const depsText = def.dependsOn.length
    ? t("ws.plan.after", { deps: def.dependsOn.map((dep) => TASK_BY_ID[dep].title[lang]).join(", ") })
    : t("ws.plan.noDeps");
  return (
    <li>
      <Card as="article" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 font-semibold">{def.title[lang]}</h2>
          <StatusChip status={state.status} />
        </div>
        <p className="text-sm text-[var(--muted)]">
          {t(`role.${def.role}`)} · {depsText}
          {state.attempts > 0 ? ` · ${t("run.attempt", { n: state.attempts, max: def.maxAttempts })}` : ""}
        </p>
        {state.error ? (
          <Notice tone={state.status === "blocked" || state.status === "waiting" ? "warning" : "danger"}>{state.error}</Notice>
        ) : null}
        {state.evidence.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {state.evidence.map((item) => (
              <li key={`${item.label}-${item.value}`} className="break-words">
                <span className="text-[var(--muted)]">{item.label}: </span>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.value}
                  </a>
                ) : (
                  <span>{item.value}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {state.output ? (
          <details>
            <summary>{t("common.details")}</summary>
            <pre className="mono mt-2 whitespace-pre-wrap">{state.output}</pre>
          </details>
        ) : null}
      </Card>
    </li>
  );
}

function ApprovalCard({ runId, gate, onDone }: { runId: string; gate: TaskId; onDone: (run: Run) => void }) {
  const { t, lang } = useI18n();
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = GATE_PHRASES[gate] ?? "";
  const hint = gate === "approve_deploy" ? t("run.approve.hintDeploy") : t("run.approve.hintMerge");

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const data = await apiRequest<{ run?: Run; summary?: unknown }>(`/api/runs/${runId}/approve`, { body: { gate, phrase } });
      if (data.run) onDone(data.run);
      setPhrase("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 border-violet-300">
      <h2 className="text-lg font-semibold">{t("run.approve.title")}: {TASK_BY_ID[gate].title[lang]}</h2>
      <p className="text-[var(--muted)]">{hint}</p>
      <label htmlFor={`approve-${gate}`} className="text-sm font-medium">
        {t("run.approve.input")}: {expected}
      </label>
      <input
        id={`approve-${gate}`}
        className="field"
        value={phrase}
        autoCapitalize="characters"
        autoComplete="off"
        onChange={(event) => setPhrase(event.target.value)}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button variant="primary" onClick={approve} disabled={busy || phrase.trim() !== expected}>
        {busy ? t("common.loading") : `${t("run.approve.button")}`}
      </Button>
    </Card>
  );
}

type ReviewData = {
  connected: boolean;
  branch: string | null;
  headSha: string | null;
  baseSha: string | null;
  reviewOutput: string | null;
  reviewError: string | null;
  auditOutput: string | null;
  auditError: string | null;
  approvals: { gate: string; at: string; by: string }[];
  files: { path: string; status: string; additions: number; deletions: number; patch: string | null; patchTruncated: boolean }[];
  checks: { name: string; status: string; conclusion: string | null; url: string }[];
};

function ReviewPanel({ runId, run }: { runId: string; run: Run }) {
  const { t } = useI18n();
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPatch, setOpenPatch] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<ReviewData>(`/api/runs/${runId}/review`)
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof ApiError ? err.message : t("err.generic"));
      });
    return () => {
      alive = false;
    };
  }, [runId, t, run.headSha, run.version]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <Spinner label={t("common.loading")} />;
  if (!data.connected) return <Notice tone="info">{t("review.noConnection")}</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("review.files", { n: data.files.length })}</h2>
        {data.files.length === 0 ? <p className="text-[var(--muted)]">{t("review.noChanges")}</p> : null}
        <ul className="flex flex-col gap-2">
          {data.files.map((file) => (
            <li key={file.path} className="rounded-xl border border-[var(--line)] p-3">
              <p className="break-all font-mono text-sm">{file.path}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {file.status} · <span className="text-[var(--success)]">+{file.additions}</span>{" "}
                <span className="text-[var(--danger)]">−{file.deletions}</span>
              </p>
              {file.patch ? (
                <div className="mt-2">
                  <Button variant="secondary" onClick={() => setOpenPatch(openPatch === file.path ? null : file.path)}>
                    {openPatch === file.path ? t("review.hideDiff") : t("review.showDiff")}
                  </Button>
                  {openPatch === file.path ? (
                    <>
                      <pre className="mono mt-2">{file.patch}</pre>
                      {file.patchTruncated ? <p className="mt-1 text-sm text-[var(--muted)]">{t("review.truncated")}</p> : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("review.checks")}</h2>
        {data.checks.length === 0 ? <p className="text-[var(--muted)]">{t("review.none")}</p> : null}
        <ul className="flex flex-col gap-2">
          {data.checks.map((check) => (
            <li key={`${check.name}-${check.url}`} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{check.name}</span>
              <Chip tone={check.conclusion === "success" ? "success" : check.status !== "completed" ? "info" : check.conclusion === "neutral" || check.conclusion === "skipped" ? "neutral" : "danger"}>
                {check.conclusion ?? check.status}
              </Chip>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("review.findings")}</h2>
        {data.reviewOutput ? <pre className="mono">{data.reviewOutput}</pre> : <p className="text-[var(--muted)]">{data.reviewError ?? t("review.none")}</p>}
        {data.auditOutput ? <pre className="mono">{data.auditOutput}</pre> : data.auditError ? <Notice tone="warning">{data.auditError}</Notice> : null}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t("review.approvals")}</h2>
        {data.approvals.length === 0 ? <p className="text-[var(--muted)]">{t("review.none")}</p> : null}
        {data.approvals.map((item) => (
          <p key={`${item.gate}-${item.at}`} className="text-sm">
            {TASK_BY_ID[item.gate as TaskId]?.title.en ?? item.gate} · {item.by} · {new Date(item.at).toLocaleString()}
          </p>
        ))}
      </Card>
    </div>
  );
}
