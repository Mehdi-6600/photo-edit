import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isStrongAccessToken, verifySessionValue } from "./lib/security";

/** Paths that do not require an owner session. */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout", "/api/health"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const token = process.env.APP_ACCESS_TOKEN?.trim();
  const configured = isStrongAccessToken(token);
  if (verifySessionValue(token, request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Please sign in again." },
      { status: configured ? 401 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|favicon.svg).*)"],
};
