"use client";

import { useEffect, useState } from "react";
import { Card, Chip, Heading, Notice, Spinner } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import type { DictKey } from "@/lib/i18n";

interface SetupStatus {
  accessToken: boolean;
  githubToken: boolean;
  githubRepository: boolean;
  model: boolean;
  modelError: string | null;
  vercelToken: boolean;
  vercelProject: boolean;
  deployHook: boolean;
  productionUrl: boolean;
  upstash: boolean;
  storage: string;
  allowMerge: boolean;
  allowedPaths: string[];
}

interface Step {
  title: DictKey;
  body: DictKey;
  required: boolean;
  checks: { label: string; ok: boolean }[];
}

export function SetupPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<SetupStatus>("/api/setup/status")
      .then((data) => {
        if (alive) setStatus(data);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof ApiError ? err.message : t("err.generic"));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!status) return <Spinner label={t("common.loading")} />;

  const steps: Step[] = [
    { title: "setup.step.access", body: "setup.step.access.body", required: true, checks: [{ label: "APP_ACCESS_TOKEN", ok: status.accessToken }] },
    {
      title: "setup.step.github",
      body: "setup.step.github.body",
      required: true,
      checks: [
        { label: "GITHUB_TOKEN", ok: status.githubToken },
        { label: "GITHUB_REPOSITORY", ok: status.githubRepository },
      ],
    },
    {
      title: "setup.step.model",
      body: "setup.step.model.body",
      required: true,
      checks: [{ label: "LLM_BASE_URL + LLM_MODEL", ok: status.model }],
    },
    {
      title: "setup.step.vercel",
      body: "setup.step.vercel.body",
      required: false,
      checks: [
        { label: "VERCEL_TOKEN", ok: status.vercelToken },
        { label: "VERCEL_PROJECT_ID", ok: status.vercelProject },
        { label: "VERCEL_DEPLOY_HOOK_URL", ok: status.deployHook },
        { label: "PRODUCTION_URL", ok: status.productionUrl },
      ],
    },
    {
      title: "setup.step.storage",
      body: "setup.step.storage.body",
      required: false,
      checks: [{ label: "UPSTASH_REDIS_REST_URL + TOKEN", ok: status.upstash }],
    },
    {
      title: "setup.step.merge",
      body: "setup.step.merge.body",
      required: false,
      checks: [{ label: "AGENT_STUDIO_ALLOW_MERGE", ok: status.allowMerge }],
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("setup.title")} subtitle={t("setup.subtitle")} />
      <p className="text-sm text-[var(--muted)]">{t("setup.storageKind", { kind: status.storage })}</p>
      {status.modelError ? <Notice tone="danger">{status.modelError}</Notice> : null}

      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.title}>
            <Card as="article" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{t(step.title)}</h2>
                <Chip tone={step.required ? "warning" : "neutral"}>{step.required ? t("setup.required") : t("setup.optional")}</Chip>
              </div>
              <p className="text-[var(--ink)]">{t(step.body)}</p>
              <ul className="flex flex-col gap-2 text-sm">
                {step.checks.map((check) => (
                  <li key={check.label} className="flex flex-wrap items-center justify-between gap-2">
                    <code className="break-all text-xs">{check.label}</code>
                    <Chip tone={check.ok ? "success" : "neutral"}>{check.ok ? t("setup.present") : t("setup.missing")}</Chip>
                  </li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </ol>

      <Card className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-semibold">AGENT_ALLOWED_PATHS</h2>
        <p className="break-words font-mono text-xs text-[var(--muted)]">{status.allowedPaths.join("  ·  ")}</p>
      </Card>
    </div>
  );
}
