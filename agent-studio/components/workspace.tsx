"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, Chip, Heading, Notice } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import { MIN_IDEA_LENGTH } from "@/lib/planner";
import type { Plan } from "@/lib/types";
import { TASKS, TASK_BY_ID, type TaskId } from "@/lib/workflow";

const EXAMPLE_IDEA = "Build a multilingual appointment-booking website for a small barbershop, with English and Persian pages.";

const PRIORITY_TONE = { must: "danger", should: "warning", could: "neutral" } as const;

export function Workspace() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"analyze" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repository, setRepository] = useState<{ repo: string | null; token: boolean } | null>(null);

  useEffect(() => {
    apiRequest<{ repository: string | null; tokenConfigured: boolean }>("/api/github/status")
      .then((data) => setRepository({ repo: data.repository, token: data.tokenConfigured }))
      .catch(() => setRepository({ repo: null, token: false }));
  }, []);

  async function analyze() {
    setError(null);
    if (idea.trim().length < MIN_IDEA_LENGTH) {
      setError(t("ws.idea.tooShort"));
      return;
    }
    setBusy("analyze");
    try {
      const data = await apiRequest<{ plan: Plan }>("/api/analyze", { body: { idea } });
      setPlan(data.plan);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    if (!plan) return;
    setError(null);
    setBusy("start");
    try {
      const data = await apiRequest<{ id: string }>("/api/runs", { body: { plan } });
      router.push(`/runs/${data.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("err.generic"));
      setBusy(null);
    }
  }

  const dependencyLabel = (taskId: TaskId) => {
    const deps = TASK_BY_ID[taskId].dependsOn;
    if (deps.length === 0) return t("ws.plan.noDeps");
    return t("ws.plan.after", { deps: deps.map((dep) => TASK_BY_ID[dep].title[lang]).join(", ") });
  };

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("ws.title")} subtitle={t("ws.subtitle")} />

      {repository && !repository.repo ? <Notice tone="info">{t("ws.plan.repoMissing")}</Notice> : null}

      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="idea" className="text-base font-medium">
            {t("ws.idea.label")}
          </label>
          <textarea
            id="idea"
            className="field"
            rows={5}
            maxLength={2000}
            placeholder={t("ws.idea.placeholder")}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            dir="auto"
          />
          <p className="text-sm text-[var(--muted)]">{idea.length}/2000</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="secondary" onClick={() => setIdea(EXAMPLE_IDEA)} disabled={busy !== null}>
            {t("ws.idea.example")}
          </Button>
          <Button variant="primary" onClick={analyze} disabled={busy !== null || idea.trim().length === 0}>
            {busy === "analyze" ? t("ws.analyzing") : t("ws.analyze")}
          </Button>
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Card>

      {plan ? (
        <section className="flex flex-col gap-4" aria-labelledby="plan-title">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="plan-title" className="text-xl font-semibold">
                {t("ws.plan.title")}
              </h2>
              <Chip tone={plan.planner.mode === "model" ? "info" : "neutral"}>
                {plan.planner.mode === "model"
                  ? t("ws.plan.plannerModel", { model: plan.planner.model ?? "" })
                  : t("ws.plan.plannerHeuristic")}
              </Chip>
            </div>
            <h3 className="text-lg font-semibold">{plan.title}</h3>
            <p className="text-[var(--ink)]">{plan.summary}</p>
            {plan.planner.warnings.map((warning) => (
              <Notice key={warning} tone="warning">
                {warning}
              </Notice>
            ))}
            {plan.questions.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h4 className="font-semibold">{t("ws.plan.questions")}</h4>
                <ul className="list-disc ps-5">
                  {plan.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.assumptions.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h4 className="font-semibold">{t("ws.plan.assumptions")}</h4>
                <ul className="list-disc ps-5 text-[var(--muted)]">
                  {plan.assumptions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">{t("ws.plan.requirements")}</h3>
            <ul className="flex flex-col gap-3">
              {plan.requirements.map((req) => (
                <li key={req.id} className="rounded-xl border border-[var(--line)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-[var(--muted)]">{req.id}</span>
                    <Chip tone={PRIORITY_TONE[req.priority]}>{req.priority}</Chip>
                  </div>
                  <p className="mt-2 font-medium">{req.text}</p>
                  <p className="mt-2 text-sm text-[var(--muted)]">{t("ws.plan.acceptance")}</p>
                  <ul className="ps-5 text-sm">
                    {req.acceptance.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">{t("ws.plan.tasks")}</h3>
            <ol className="flex flex-col gap-2">
              {TASKS.filter((task) => !task.conditional).map((task, index) => (
                <li key={task.id} className="flex gap-3 rounded-xl border border-[var(--line)] p-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--bg)] text-sm font-semibold">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold">{task.title[lang]}</p>
                    <p className="text-sm text-[var(--muted)]">{dependencyLabel(task.id)}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-sm text-[var(--muted)]">{t("ws.plan.approvalNote")}</p>
          </Card>

          {repository?.repo ? (
            <Notice tone="info">{t("ws.plan.repoTarget", { repo: repository.repo })}</Notice>
          ) : null}
          <Button variant="primary" onClick={start} disabled={busy !== null}>
            {busy === "start" ? t("ws.plan.starting") : t("ws.plan.start")}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
