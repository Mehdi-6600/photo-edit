import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";
import { clientKey, rateLimit, redact, stripControlChars } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Sends a minimal, owner-triggered connectivity probe. Raw model output is never returned or stored. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const limit = rateLimit(`model-check:${clientKey(request)}`, 3, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many model checks. Wait a minute and try again.");
    if (!services.model) throw new HttpError(422, "No model is configured. Set LLM_BASE_URL and LLM_MODEL first.");

    const startedAt = services.now().getTime();
    const response = await services.model.chat(
      [
        { role: "system", content: "This is a connectivity check. Reply with exactly the two letters OK and nothing else." },
        { role: "user", content: "Reply OK." },
      ],
      { maxTokens: 8, temperature: 0, maxAttempts: 1 },
    );
    const elapsedMs = Math.max(0, services.now().getTime() - startedAt);
    const replyAccepted = /^ok[.!]?$/i.test(response.text.trim());
    const safeModel = stripControlChars(redact(response.model, services.config.secrets)).slice(0, 120);
    await services.audit({
      actor: "owner",
      action: "model.connectivity_check",
      target: safeModel,
      result: replyAccepted ? "ok" : "error",
      detail: `${elapsedMs}ms`,
    });
    return json({ ok: true, replyAccepted, model: safeModel, elapsedMs });
  });
}
