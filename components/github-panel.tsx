"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Heading, Notice, Spinner, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import type { DictKey } from "@/lib/i18n";

interface GitHubStatus {
  tokenConfigured: boolean;
  repository: string | null;
  repositorySource: "ui" | "environment" | null;
  repositoryLocked: boolean;
  repositoryConfigError: string | null;
  viewer: string | null;
  access: { read: boolean; push: boolean; admin: boolean } | null;
  defaultBranch: string | null;
  error: string | null;
}

interface Snapshot {
  repo: { fullName: string; defaultBranch: string; htmlUrl: string; archived: boolean };
  commits: { sha: string; message: string; author: string; date: string }[];
  pulls: { number: number; title: string; url: string; head: string }[];
  topLevel: string[];
}

interface PermissionProbe {
  authenticatedAs: string | null;
  defaultBranch: string | null;
  repositoryReadable: boolean;
  contentsReadable: boolean;
  actionsReadable: boolean;
  checksReadable: boolean;
  pullRequestsReadable: boolean;
  accountCanPush: boolean | null;
}

export function GitHubPanel() {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<PermissionProbe | null>(null);
  const [probeAccount, setProbeAccount] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "danger" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest<GitHubStatus>("/api/github/status");
      setStatus(data);
      if (data.repository && data.tokenConfigured) {
        try {
          setSnapshot(await apiRequest<Snapshot>("/api/github/snapshot"));
        } catch {
          setSnapshot(null);
        }
      } else {
        setSnapshot(null);
      }
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? err.message : t("err.generic") });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveRepository() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await apiRequest<{ repository: string }>("/api/github/repository", { body: { repository: repoInput.trim() } });
      setMessage({ tone: "success", text: data.repository });
      setRepoInput("");
      setProbe(null);
      setProbeAccount(null);
      await load();
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? err.message : t("err.generic") });
    } finally {
      setBusy(false);
    }
  }

  async function checkAccess() {
    setProbing(true);
    setProbe(null);
    setProbeAccount(null);
    setMessage(null);
    try {
      const result = await apiRequest<{ repository: string | null; probes: PermissionProbe | null; authenticatedAs: string | null }>("/api/github/check", { body: {} });
      setProbe(result.probes);
      setProbeAccount(result.authenticatedAs);
      if (!result.authenticatedAs) setMessage({ tone: "danger", text: t("gh.tokenMissing") });
      else if (!result.repository) setMessage({ tone: "info", text: t("gh.probeNoRepository") });
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? err.message : t("err.generic") });
    } finally {
      setProbing(false);
    }
  }

  if (!status) return <Spinner label={t("common.loading")} />;

  const probeRows: { label: DictKey; ok: boolean | null }[] = probe
    ? [
        { label: "gh.probeToken", ok: Boolean(probe.authenticatedAs) },
        { label: "gh.probeRepo", ok: probe.repositoryReadable },
        { label: "gh.probeContents", ok: probe.contentsReadable },
        { label: "gh.probeActions", ok: probe.actionsReadable },
        { label: "gh.probeChecks", ok: probe.checksReadable },
        { label: "gh.probePulls", ok: probe.pullRequestsReadable },
        { label: "gh.probePush", ok: probe.accountCanPush },
      ]
    : [];

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("gh.title")} subtitle={t("gh.subtitle")} />

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Chip tone={status.tokenConfigured ? "success" : "warning"}>
            {status.tokenConfigured ? t("gh.tokenPresent") : t("gh.tokenMissing")}
          </Chip>
          {status.viewer ? <Chip tone="info">{t("gh.signedIn", { login: status.viewer })}</Chip> : null}
          {!status.viewer && status.tokenConfigured ? <Chip tone="neutral">{t("gh.notConnected")}</Chip> : null}
        </div>
        {status.error ? <Notice tone="danger">{status.error}</Notice> : null}
        {status.repositoryConfigError ? <Notice tone="danger">{status.repositoryConfigError}</Notice> : null}
        {status.repositoryLocked ? <Notice tone="info">{t("gh.lockedHint")}</Notice> : null}
        {status.repository ? (
          <dl className="kv">
            <dt>{t("gh.repo")}</dt>
            <dd>
              <a href={`https://github.com/${status.repository}`} target="_blank" rel="noopener noreferrer">
                {status.repository}
              </a>
            </dd>
            <dt>{t("gh.defaultBranch")}</dt>
            <dd>{status.defaultBranch ?? t("common.unknown")}</dd>
            <dt>{t("gh.permissions")}</dt>
            <dd>
              <span className="block">{status.access?.read ? "✓" : "✕"} {t("gh.canRead")}</span>
              <span className="block">{status.access?.push ? "✓" : "✕"} {t("gh.canPush")}</span>
            </dd>
          </dl>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t("gh.permissions")}</h2>
        <Button variant="secondary" onClick={checkAccess} disabled={probing || !status.tokenConfigured || Boolean(status.repositoryConfigError)}>
          {probing ? t("gh.checking") : t("gh.checkAccess")}
        </Button>
        {probeAccount ? <Chip tone="success">{t("gh.signedIn", { login: probeAccount })}</Chip> : null}
        {probe ? (
          <>
            <h3 className="font-semibold">{t("gh.probeTitle")}</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {probeRows.map(({ label, ok }) => (
                <li key={label} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t(label)}</span>
                  <Chip tone={ok === true ? "success" : ok === false ? "danger" : "neutral"}>
                    {ok === true ? t("common.yes") : ok === false ? t("common.no") : t("common.unknown")}
                  </Chip>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[var(--muted)]">{t("gh.probeWriteNote")}</p>
          </>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <label htmlFor="repo" className="text-base font-medium">
          {t("gh.repo")}
        </label>
        <input
          id="repo"
          className="field"
          placeholder={t("gh.repoPlaceholder")}
          disabled={status.repositoryLocked || Boolean(status.repositoryConfigError)}
          value={repoInput}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setRepoInput(event.target.value)}
        />
        <Button
          variant="primary"
          onClick={saveRepository}
          disabled={busy || !status.tokenConfigured || status.repositoryLocked || Boolean(status.repositoryConfigError) || repoInput.trim().length < 3}
        >
          {busy ? t("common.loading") : t("gh.saveRepo")}
        </Button>
        {message ? <Notice tone={message.tone === "success" ? "success" : message.tone === "danger" ? "danger" : "info"}>{message.text}</Notice> : null}
      </Card>

      {snapshot ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{t("gh.snapshot")}</h2>
          <div>
            <h3 className="font-semibold">{t("gh.commits")}</h3>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {snapshot.commits.map((commit) => (
                <li key={commit.sha} className="break-words">
                  <span className="font-mono text-[var(--muted)]">{commit.sha}</span> {commit.message}{" "}
                  <span className="text-[var(--muted)]">· {commit.author} · {relativeTime(commit.date, lang)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">{t("gh.prs")}</h3>
            {snapshot.pulls.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">—</p> : null}
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {snapshot.pulls.map((pull) => (
                <li key={pull.number}>
                  <a href={pull.url} target="_blank" rel="noopener noreferrer">
                    #{pull.number} {pull.title}
                  </a>{" "}
                  <span className="text-[var(--muted)]">({pull.head})</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">{t("gh.topLevel")}</h3>
            <p className="mt-2 break-words font-mono text-sm text-[var(--muted)]">{snapshot.topLevel.join("  ·  ")}</p>
          </div>
        </Card>
      ) : null}

      <Notice tone="info">{t("gh.rule")}</Notice>
    </div>
  );
}
