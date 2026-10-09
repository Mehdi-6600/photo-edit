"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { LangToggle, useI18n } from "./i18n-provider";
import { apiRequest } from "@/lib/client-api";
import type { DictKey } from "@/lib/i18n";

const NAV: { href: string; key: DictKey }[] = [
  { href: "/", key: "nav.workspace" },
  { href: "/runs", key: "nav.runs" },
  { href: "/team", key: "nav.team" },
  { href: "/github", key: "nav.github" },
  { href: "/deploy", key: "nav.deploy" },
  { href: "/registry", key: "nav.registry" },
  { href: "/setup", key: "nav.setup" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const isLogin = pathname === "/login";

  async function signOut() {
    setSigningOut(true);
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex min-w-0 items-center gap-2 no-underline">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-sm font-bold text-white" aria-hidden="true">
              AS
            </span>
            <span className="truncate text-base font-semibold text-[var(--ink)]">{t("app.name")}</span>
          </Link>
          <div className="flex items-center gap-2">
            <LangToggle />
            {!isLogin ? (
              <button type="button" className="btn btn-ghost" onClick={signOut} disabled={signingOut}>
                {t("common.logout")}
              </button>
            ) : null}
          </div>
        </div>
        {!isLogin ? (
          <nav aria-label="Main" className="mx-auto w-full max-w-3xl overflow-x-auto px-2 pb-2">
            <ul className="flex min-w-max gap-1">
              {NAV.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`tab ${active ? "tab-active" : ""}`}
                    >
                      {t(item.key)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-6">{children}</main>
    </div>
  );
}
