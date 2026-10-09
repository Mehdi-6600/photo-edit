"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo } from "react";
import { LANG_COOKIE, type Lang, type Translator, makeTranslator, textDirection } from "@/lib/i18n";

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: Translator;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ lang, dir: textDirection(lang), t: makeTranslator(lang) }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside LangProvider");
  return value;
}

export function LangToggle() {
  const { lang, t } = useI18n();
  const router = useRouter();
  const switchTo = useCallback(
    (next: Lang) => {
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      router.refresh();
    },
    [router],
  );
  return (
    <button
      type="button"
      onClick={() => switchTo(lang === "en" ? "fa" : "en")}
      className="btn btn-ghost min-w-[4.5rem]"
      aria-label={lang === "en" ? t("lang.switchToPersian") : t("lang.switchToEnglish")}
    >
      {t("lang.switch")}
    </button>
  );
}
