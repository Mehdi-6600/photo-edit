"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Heading, Notice, Spinner, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";

interface DeployStatus {
  tokenConfigured: boolean;
  projectConfigured: boolean;
  hookConfigured: boolean;
  productionUrl: string | null;
  deployments: { id: string; url: string; state: string; target: string | null; createdAt: string }[];
  error: string | null;
}

interface VerifyResult {
  ok: boolean;
  status: number | null;
  title: string | null;
  checkedAt: string;
  reason?: string;
}

export function DeployPanel() {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState<"verify" | "hook" | null>(null);
  const [confirm, setConfirm] = useState("");
  const [hookMessage, setHookMessage] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiRequest<DeployStatus>("/api/deploy/status"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : t("err.generic"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function checkUrl() {
    setBusy("verify");
    try {
      setVerify(await apiRequest<VerifyResult>("/api/deploy/verify", { body: {} }));
    } catch (err) {
      setVerify({ ok: false, status: null, title: null, checkedAt: new Date().toISOString(), reason: err instanceof ApiError ? err.message : t("err.generic") });
    } finally {
      setBusy(null);
    }
  }

  async function triggerDeploy() {
    setBusy("hook");
    setHookError(null);
    setHookMessage(null);
    try {
      const data = await apiRequest<{ ok: boolean; status: number }>("/api/deploy/hook", { body: { confirm } });
      setHookMessage(t("deploy.hookDone", { status: data.status }));
      setConfirm("");
    } catch (err) {
      setHookError(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <Notice tone="danger">{loadError}</Notice>;
  if (!status) return <Spinner label={t("common.loading")} />;

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("deploy.title")} subtitle={t("deploy.subtitle")} />

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("deploy.config")}</h2>
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex flex-wrap items-center justify-between gap-2">VERCEL_TOKEN <Chip tone={status.tokenConfigured ? "success" : "neutral"}>{status.tokenConfigured ? t("setup.present") : t("setup.missing")}</Chip></li>
          <li className="flex flex-wrap items-center justify-between gap-2">VERCEL_PROJECT_ID <Chip tone={status.projectConfigured ? "success" : "neutral"}>{status.projectConfigured ? t("setup.present") : t("setup.missing")}</Chip></li>
          <li className="flex flex-wrap items-center justify-between gap-2">VERCEL_DEPLOY_HOOK_URL <Chip tone={status.hookConfigured ? "success" : "neutral"}>{status.hookConfigured ? t("setup.present") : t("setup.missing")}</Chip></li>
          <li className="flex flex-wrap items-center justify-between gap-2">PRODUCTION_URL <Chip tone={status.productionUrl ? "success" : "neutral"}>{status.productionUrl ?? t("setup.missing")}</Chip></li>
        </ul>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("deploy.verify")}</h2>
        <Button variant="secondary" onClick={checkUrl} disabled={busy !== null || !status.productionUrl}>
          {busy === "verify" ? t("common.loading") : t("deploy.verify")}
        </Button>
        {verify ? (
          <Notice tone={verify.ok ? "success" : "warning"}>
            {verify.ok
              ? t("deploy.verifyOk", { status: verify.status ?? 0 })
              : t("deploy.verifyFail", { reason: verify.reason ?? "unknown" })}
            <span className="block text-sm">{relativeTime(verify.checkedAt, lang)}{verify.title ? ` · ${verify.title}` : ""}</span>
          </Notice>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("deploy.hook")}</h2>
        {status.hookConfigured ? (
          <>
            <p className="text-sm text-[var(--muted)]">{t("deploy.hookHint")}</p>
            <label htmlFor="deploy-confirm" className="text-sm font-medium">
              DEPLOY
            </label>
            <input
              id="deploy-confirm"
              className="field"
              value={confirm}
              autoComplete="off"
              autoCapitalize="characters"
              onChange={(event) => setConfirm(event.target.value)}
            />
            <Button variant="danger" onClick={triggerDeploy} disabled={busy !== null || confirm.trim() !== "DEPLOY"}>
              {busy === "hook" ? t("common.loading") : t("deploy.hook")}
            </Button>
            {hookMessage ? <Notice tone="success">{hookMessage}</Notice> : null}
            {hookError ? <Notice tone="danger">{hookError}</Notice> : null}
          </>
        ) : (
          <Notice tone="info">{t("deploy.hookMissing")}</Notice>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t("deploy.recent")}</h2>
        {!status.tokenConfigured || !status.projectConfigured ? <p className="text-sm text-[var(--muted)]">{t("deploy.noList")}</p> : null}
        {status.error ? <Notice tone="warning">{status.error}</Notice> : null}
        <ul className="flex flex-col gap-2 text-sm">
          {status.deployments.map((item) => (
            <li key={item.id} className="rounded-xl border border-[var(--line)] p-3">
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="break-all">
                {item.url}
              </a>
              <p className="mt-1 text-[var(--muted)]">
                {item.state} · {item.target ?? "preview"} · {relativeTime(item.createdAt, lang)}
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
