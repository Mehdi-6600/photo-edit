import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { InvalidActionError, NotFoundError, getServices, type Services } from "./services";
import { ConflictError, InvalidInputError } from "./store";
import { SESSION_COOKIE, isTrustedWriteRequest, redact, verifySessionValue } from "./security";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/** Requires a valid owner session. proxy.ts enforces the same rule; this is defense in depth. */
export function requireSession(request: NextRequest, services: Services): void {
  const token = services.config.accessToken;
  if (!token) throw new HttpError(503, "Owner access is not configured. Set APP_ACCESS_TOKEN.");
  if (!verifySessionValue(token, request.cookies.get(SESSION_COOKIE)?.value)) {
    throw new HttpError(401, "Please sign in again.");
  }
}

export async function readJson<T = unknown>(request: Request, maxBytes = 64_000): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "The request is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new HttpError(413, "The request is too large.");
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

/** Maps any thrown error to an HTTP response. Internal details are logged server-side, never returned. */
export function handleError(error: unknown, services?: Services): NextResponse {
  const secrets = services?.config.secrets ?? [];
  if (error instanceof HttpError) return json({ error: redact(error.message, secrets) }, error.status);
  if (error instanceof NotFoundError) return json({ error: error.message }, 404);
  if (error instanceof InvalidInputError) return json({ error: error.message }, 400);
  if (error instanceof InvalidActionError) return json({ error: error.message }, 422);
  if (error instanceof ConflictError) {
    return json({ error: "This run changed in another tab. Reload and try again." }, 409);
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path.join(".") || "request";
    return json({ error: `Invalid input (${field}): ${first?.message ?? "not accepted"}` }, 400);
  }
  const message = error instanceof Error ? redact(error.message, secrets) : "Unexpected error.";
  console.error("[agent-studio]", message);
  return json({ error: message.slice(0, 300) }, 500);
}

/**
 * Runs a route body after the session check. Mutating routes must send JSON from this site,
 * which blocks cross-site form posts (CSRF) in addition to the SameSite=Strict session cookie.
 */
export async function withSession(
  request: NextRequest,
  options: { write: boolean },
  handler: (services: Services) => Promise<NextResponse>,
): Promise<NextResponse> {
  let services: Services | undefined;
  try {
    services = getServices();
    if (options.write && !isTrustedWriteRequest(request)) {
      throw new HttpError(415, "Requests must be JSON from this site.");
    }
    requireSession(request, services);
    return await handler(services);
  } catch (error) {
    return handleError(error, services);
  }
}
