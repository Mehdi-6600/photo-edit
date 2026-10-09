import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "@fontsource-variable/vazirmatn";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { LangProvider } from "@/components/i18n-provider";
import { LANG_COOKIE, parseLang, textDirection } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "Coordinate open-source AI coding agents through GitHub and Vercel.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f766e",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const lang = parseLang(jar.get(LANG_COOKIE)?.value);
  return (
    <html lang={lang} dir={textDirection(lang)}>
      <body>
        <LangProvider lang={lang}>
          <AppShell>{children}</AppShell>
        </LangProvider>
      </body>
    </html>
  );
}
