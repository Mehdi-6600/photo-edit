"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Heading, Notice, Spinner, relativeTime } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";
import type { DictKey } from "@/lib/i18n";
import type { EffectiveAgent } from "@/lib/registry";

interface RegistryResponse {
  researchedAt: string;
  method: string;
  freeUseClasses: Record<string, string>;
  lastRevalidatedAt: string | null;
  agents: EffectiveAgent[];
}

type Filter = "all" | "active" | "optional" | "excluded";

const STATUS_TONE = { active: "success", optional: "info", excluded: "danger" } as const;

const STATUS_FILTER_KEY: Record<Filter, DictKey> = {
  all: "reg.all",
  active: "reg.active",
  optional: "reg.optional",
  excluded: "reg.excluded",
};

const MAX_COMPARE = 3;

export function RegistryPanel() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<RegistryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [compare, setCompare] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<RegistryResponse>("/api/registry"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("err.generic"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.agents.filter((agent) => {
      if (filter === "active" && agent.status !== "active") return false;
      if (filter === "optional" && agent.status !== "optional") return false;
      if (filter === "excluded" && agent.status !== "excluded") return false;
      if (!needle) return true;
      return `${agent.name} ${agent.repo} ${agent.category} ${agent.roles.join(" ")}`.toLowerCase().includes(needle);
    });
  }, [data, filter, query]);

  async function toggle(agent: EffectiveAgent) {
    setBusy(agent.id);
    setNotice(null);
    try {
      await apiRequest(`/api/registry/${agent.id}`, { method: "PATCH", body: { enabled: !agent.enabled } });
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(null);
    }
  }

  async function revalidate() {
    setBusy("revalidate");
    setNotice(null);
    try {
      const result = await apiRequest<{ checkedAt: string; results: { ok: boolean }[] }>("/api/registry/revalidate", { body: {} });
      const okCount = result.results.filter((item) => item.ok).length;
      setNotice(`${okCount}/${result.results.length} · ${relativeTime(result.checkedAt, lang)}`);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(null);
    }
  }

  function toggleCompare(id: string) {
    setCompare((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_COMPARE) return current;
      return [...current, id];
    });
  }

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <Spinner label={t("common.loading")} />;

  const selected = data.agents.filter((agent) => compare.includes(agent.id));

  return (
    <div className="flex flex-col gap-5">
      <Heading title={t("reg.title")} subtitle={t("reg.subtitle")} />
      <Notice tone="info">{t("reg.runtimeNotice")}</Notice>

      <Card className="flex flex-col gap-3">
        <label htmlFor="agent-search" className="text-base font-medium">
          {t("reg.search")}
        </label>
        <input
          id="agent-search"
          className="field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
        />
        <div role="group" aria-label={t("reg.sort")} className="flex flex-wrap gap-2">
          {(["all", "active", "optional", "excluded"] as Filter[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              className={`tab ${filter === item ? "tab-active" : "btn-secondary"} border border-[var(--line)]`}
              onClick={() => setFilter(item)}
            >
              {t(STATUS_FILTER_KEY[item])}
            </button>
          ))}
        </div>
        <p className="text-sm text-[var(--muted)]">
          {t("reg.sort")} · {t("reg.compareHint")} · {data.researchedAt}
          {data.lastRevalidatedAt ? ` · ${t("reg.live")}: ${relativeTime(data.lastRevalidatedAt, lang)}` : ""}
        </p>
        <Button variant="secondary" onClick={revalidate} disabled={busy !== null}>
          {busy === "revalidate" ? t("common.loading") : t("reg.revalidate")}
        </Button>
        {notice ? <Notice tone="info">{notice}</Notice> : null}
      </Card>

      {selected.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t("reg.compare")}</h2>
            <Button variant="ghost" onClick={() => setCompare([])}>
              {t("reg.compareClose")}
            </Button>
          </div>
          {selected.map((agent) => (
            <div key={agent.id} className="rounded-xl border border-[var(--line)] p-3">
              <p className="font-semibold">{agent.name}</p>
              <dl className="kv mt-2">
                <dt>{t("reg.score", { n: agent.score ?? 0 })}</dt>
                <dd>{agent.score ?? "—"}</dd>
                <dt>{t("reg.license")}</dt>
                <dd>{agent.license.spdx}</dd>
                <dt>{t("reg.freeUse")}</dt>
                <dd>{agent.freeUse.classes.join(", ") || "—"}</dd>
                <dt>{t("reg.hardware")}</dt>
                <dd>{agent.requirements.runtime}</dd>
              </dl>
            </div>
          ))}
        </Card>
      ) : null}

      {visible.length === 0 ? <p className="text-[var(--muted)]">{t("reg.none")}</p> : null}

      <ul className="flex flex-col gap-3">
        {visible.map((agent) => (
          <li key={agent.id}>
            <Card as="article" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">{agent.name}</h2>
                  <a href={`https://github.com/${agent.repo}`} target="_blank" rel="noopener noreferrer" className="break-all text-sm">
                    {agent.repo}
                  </a>
                </div>
                <Chip tone={STATUS_TONE[agent.status]}>{t(STATUS_FILTER_KEY[agent.status])}</Chip>
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip tone={agent.license.osi ? "success" : "danger"}>{agent.license.osi ? t("reg.osi") : t("reg.notOsi")}</Chip>
                {agent.score !== null ? <Chip tone="info">{t("reg.score", { n: agent.score })}</Chip> : null}
                {agent.maintenance.archived ? <Chip tone="danger">{t("reg.archived")}</Chip> : null}
                {agent.freeUse.classes.map((item) => (
                  <Chip key={item} tone="neutral">
                    {item}
                  </Chip>
                ))}
              </div>
              <p className="text-sm text-[var(--muted)]">
                {t("reg.lastPush")}: {agent.maintenance.pushedAt ?? "—"} · {t("reg.release")}: {agent.maintenance.latestRelease}
                {agent.maintenance.latestReleaseAt ? ` (${agent.maintenance.latestReleaseAt})` : ""}
              </p>
              {agent.exclusionReason ? <Notice tone="warning">{agent.exclusionReason}</Notice> : null}
              <details>
                <summary>{t("reg.evidence")}</summary>
                <div className="mt-2 flex flex-col gap-3 text-sm">
                  <p>{agent.freeUse.note}</p>
                  <p>
                    <span className="text-[var(--muted)]">{t("reg.integration")}: </span>
                    {agent.integration.verified}
                    {agent.integration.invocation ? <code className="mt-1 block break-words text-xs">{agent.integration.invocation}</code> : null}
                  </p>
                  <p>
                    <span className="text-[var(--muted)]">{t("reg.adapter")}: </span>
                    {agent.adapter.status} — {agent.adapter.note}
                  </p>
                  <p>
                    <span className="text-[var(--muted)]">{t("reg.risks")}: </span>
                    {agent.risks.join(" ")}
                  </p>
                  <ul className="list-disc ps-5">
                    {agent.evidence.map((item) => (
                      <li key={item.url + item.claim}>
                        <a href={item.url} target="_blank" rel="noopener noreferrer">
                          {item.claim}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[var(--muted)]">{t("reg.hardware")}: {agent.requirements.runtime}</p>
                </div>
              </details>
              <div className="grid gap-2 sm:grid-cols-2">
                {agent.status !== "excluded" ? (
                  <Button variant={agent.enabled ? "secondary" : "primary"} onClick={() => toggle(agent)} disabled={busy !== null}>
                    {agent.enabled ? t("reg.enabled") : t("reg.disabled")}
                  </Button>
                ) : (
                  <span className="text-sm text-[var(--muted)]">{t("reg.excluded")}</span>
                )}
                <Button variant="secondary" onClick={() => toggleCompare(agent.id)} aria-pressed={compare.includes(agent.id)}>
                  {compare.includes(agent.id) ? "✓ " : ""}
                  {t("reg.compare")}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
