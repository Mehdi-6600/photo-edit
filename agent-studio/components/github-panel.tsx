"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Heading, Notice, Spinner, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";

interface GitHubStatus {
  tokenConfigured: boolean;
  repository: string | null;
  repositorySource: "ui" | "environment" | null;
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

export function GitHubPanel() {
  const { t, lang } = useI18n();
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [busy, setBusy] = useState(false);
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
      await load();
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof ApiError ? err.message : t("err.generic") });
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Spinner label={t("common.loading")} />;

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
        <label htmlFor="repo" className="text-base font-medium">
          {t("gh.repo")}
        </label>
        <input
          id="repo"
          className="field"
          placeholder={t("gh.repoPlaceholder")}
          value={repoInput}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setRepoInput(event.target.value)}
        />
        <Button variant="primary" onClick={saveRepository} disabled={busy || !status.tokenConfigured || repoInput.trim().length < 3}>
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
