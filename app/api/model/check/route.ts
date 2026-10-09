import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";
import { runConnectivityCheck } from "@/lib/model";
import { clientKey, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Sends a minimal, owner-triggered connectivity probe. Raw model output is never returned or stored. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const limit = rateLimit(`model-check:${clientKey(request)}`, 3, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many model checks. Wait a minute and try again.");
    if (!services.model) throw new HttpError(422, "No model is configured. Set LLM_BASE_URL and LLM_MODEL first.");

    const result = await runConnectivityCheck(services.model, {
      secrets: services.config.secrets,
      now: services.now,
    });
    await services.audit({
      actor: "owner",
      action: "model.connectivity_check",
      target: result.model ?? "unknown",
      result: result.ok && result.replyAccepted ? "ok" : "error",
      detail: `${result.elapsedMs}ms`,
    });
    if (!result.ok) {
      throw new HttpError(502, result.error ?? "The model endpoint could not be reached.");
    }
    return json({ ok: true, replyAccepted: result.replyAccepted, model: result.model, elapsedMs: result.elapsedMs });
  });
}
