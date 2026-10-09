"use client";

import { useEffect, useState } from "react";
import { Card, Chip, Heading, Notice, Spinner, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import type { DictKey } from "@/lib/i18n";
import type { RoleSummary, TeamStatus } from "@/lib/team";

const STATUS_TONE: Record<TeamStatus, "neutral" | "info" | "success"> = {
  available: "neutral",
  configured: "info",
  executed: "success",
};

const STATUS_LABEL: Record<TeamStatus, DictKey> = {
  available: "team.available",
  configured: "team.configured",
  executed: "team.executed",
};

const STATUS_HINT: Record<TeamStatus, DictKey> = {
  available: "team.availableHint",
  configured: "team.configuredHint",
  executed: "team.executedHint",
};

const ADAPTER_LABEL: Record<string, string> = {
  implemented: "implemented",
  documented: "documented",
  none: "not wired",
};

export function TeamBoard() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<{
    roles: RoleSummary[];
    modelConfigured: boolean;
    githubConfigured: boolean;
    storage: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<{ roles: RoleSummary[]; modelConfigured: boolean; githubConfigured: boolean; storage: string }>("/api/team")
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof ApiError ? err.message : t("err.generic"));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <Spinner label={t("common.loading")} />;

  const executed = data.roles.filter((role) => role.status === "executed").length;

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("team.title")} subtitle={t("team.subtitle")} />

      <Card className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["available", "configured", "executed"] as TeamStatus[]).map((status) => (
          <div key={status} className="flex flex-col gap-1">
            <Chip tone={STATUS_TONE[status]}>{t(STATUS_LABEL[status])}</Chip>
            <p className="text-sm text-[var(--muted)]">{t(STATUS_HINT[status])}</p>
          </div>
        ))}
      </Card>

      <p className="text-sm text-[var(--muted)]">
        {executed} / {data.roles.length} · {t("team.legend")}
      </p>
      {!data.modelConfigured ? <Notice tone="warning">{t("setup.step.model.body")}</Notice> : null}

      <ul className="flex flex-col gap-3">
        {data.roles.map((role) => (
          <li key={role.id}>
            <Card as="article" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{t(role.labelKey as DictKey)}</h2>
                <Chip tone={STATUS_TONE[role.status]}>{t(STATUS_LABEL[role.status])}</Chip>
              </div>
              <p className="text-sm">
                <span className="text-[var(--muted)]">{t("team.assigned")}: </span>
                {role.servedBy}
              </p>
              {role.verifiedAgents.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm">
                  {role.verifiedAgents.slice(0, 4).map((agent) => (
                    <li key={agent.id} className="flex flex-wrap items-center gap-2">
                      <span>{agent.name}</span>
                      <Chip tone={agent.adapterStatus === "documented" ? "info" : "neutral"}>
                        {ADAPTER_LABEL[agent.adapterStatus] ?? agent.adapterStatus}
                      </Chip>
                      {agent.enabled ? <Chip tone="success">{t("reg.enabled")}</Chip> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-sm text-[var(--muted)]">
                {t("team.lastResult")}:{" "}
                {role.lastResult
                  ? `${role.lastResult.title} · ${role.lastResult.status} · ${relativeTime(role.lastResult.at, lang)}`
                  : t("team.noRuns")}
              </p>
              {role.history.length > 0 ? (
                <details>
                  <summary>{t("team.history")}</summary>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {role.history.map((item) => (
                      <li key={`${item.runId}-${item.taskId}`}>
                        {item.title} · {item.status} · {relativeTime(item.at, lang)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
