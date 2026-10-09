import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, handleError, json, readJson } from "@/lib/api";
import { getServices } from "@/lib/services";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, clientKey, createSessionValue, isSecureRequest, isStrongAccessToken, isTrustedWriteRequest, rateLimit, safeEqual } from "@/lib/security";

export const runtime = "nodejs";

const LoginSchema = z.object({ token: z.string().min(1).max(256) });

export async function POST(request: NextRequest) {
  const services = getServices();
  try {
    const expected = services.config.accessToken;
    if (!isStrongAccessToken(expected)) throw new HttpError(503, "Owner access is not configured with a 32-character token. Set APP_ACCESS_TOKEN.");
    if (!isTrustedWriteRequest(request)) throw new HttpError(415, "Requests must be JSON from this site.");

    const limit = rateLimit(`login:${clientKey(request)}`, 5, 15 * 60 * 1000);
    if (!limit.allowed) {
      const response = json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const body = LoginSchema.parse(await readJson(request, 2_000));
    if (!safeEqual(body.token, expected)) {
      await services.audit({ actor: "anonymous", action: "auth.login", result: "denied" });
      return json({ error: "That token is not correct." }, 401);
    }

    await services.audit({ actor: "owner", action: "auth.login", result: "ok" });
    const response = json({ ok: true });
    response.cookies.set(SESSION_COOKIE, createSessionValue(expected), {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    return handleError(error, services);
  }
}
