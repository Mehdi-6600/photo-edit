"use client";

import { useI18n } from "./i18n-provider";
import type { DictKey } from "@/lib/i18n";
import type { TaskStatus, Run } from "@/lib/types";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "violet";

export function Card({ children, className = "", as: Tag = "section" }: { children: React.ReactNode; className?: string; as?: "section" | "article" | "div" }) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-5">
      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-[var(--ink)] sm:text-3xl">{title}</h1>
      {subtitle ? <p className="mt-2 text-base leading-relaxed text-[var(--muted)]">{subtitle}</p> : null}
    </header>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return (
    <button type="button" {...props} className={`btn btn-${variant} ${className}`}>
      {children}
    </button>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<TaskStatus | Run["status"], Tone> = {
  running: "info",
  waiting: "warning",
  paused: "neutral",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  pending: "neutral",
  ready: "info",
  blocked: "warning",
  awaiting_approval: "violet",
  held: "neutral",
  skipped: "neutral",
};

const STATUS_KEY: Record<TaskStatus | Run["status"], DictKey> = {
  running: "status.running",
  waiting: "status.waiting",
  paused: "status.paused",
  succeeded: "status.succeeded",
  failed: "status.failed",
  cancelled: "status.cancelled",
  pending: "status.pending",
  ready: "status.ready",
  blocked: "status.blocked",
  awaiting_approval: "status.awaiting_approval",
  held: "status.held",
  skipped: "status.skipped",
};

export function StatusChip({ status }: { status: TaskStatus | Run["status"] }) {
  const { t } = useI18n();
  return <Chip tone={STATUS_TONE[status]}>{t(STATUS_KEY[status])}</Chip>;
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: React.ReactNode }) {
  const role = tone === "danger" ? "alert" : "status";
  return (
    <div role={role} className={`notice notice-${tone}`}>
      {children}
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[var(--muted)]" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: React.ReactNode; id: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-base font-medium text-[var(--ink)]">
        {label}
      </label>
      {children}
      {hint ? <p className="text-sm text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

export function relativeTime(iso: string | null | undefined, lang: "en" | "fa", now: number = Date.now()): string {
  if (!iso) return "";
  const diffMinutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  const formatter = new Intl.RelativeTimeFormat(lang === "fa" ? "fa" : "en", { numeric: "auto" });
  if (diffMinutes < 1) return lang === "fa" ? "همین الان" : "just now";
  if (diffMinutes < 60) return formatter.format(-diffMinutes, "minute");
  if (diffMinutes < 60 * 24) return formatter.format(-Math.round(diffMinutes / 60), "hour");
  return formatter.format(-Math.round(diffMinutes / (60 * 24)), "day");
}
