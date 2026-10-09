"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Heading, Notice } from "./ui";
import { useI18n } from "./i18n-provider";
import { ApiError, apiRequest } from "@/lib/client-api";

function safeNext(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginForm({ next, locked }: { next: string; locked: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || token.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/auth/login", { body: { token } });
      setToken("");
      router.replace(safeNext(next));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("err.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-md">
      <Heading title={t("login.title")} subtitle={t("login.subtitle")} />
      <Card>
        {locked ? (
          <Notice tone="warning">{t("login.locked")}</Notice>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
            <div className="flex flex-col gap-2">
              <label htmlFor="access-token" className="text-base font-medium">
                {t("login.token")}
              </label>
              <input
                id="access-token"
                name="access-token"
                type="password"
                inputMode="text"
                autoComplete="current-password"
                autoCapitalize="none"
                spellCheck={false}
                className="field"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
              />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button type="submit" variant="primary" className="btn-block" disabled={busy || token.length === 0}>
              {t("login.submit")}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
