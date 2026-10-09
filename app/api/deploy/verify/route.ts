import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { verifyProductionUrl } from "@/lib/deploy";
import { clientKey, rateLimit, redact, stripControlChars } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 60;

const VerifySchema = z.object({}).strict();

/** Checks only the administrator-configured production host; request bodies cannot choose an SSRF target. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const limit = rateLimit(`deploy-verify:${clientKey(request)}`, 5, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many production checks. Wait a minute and try again.");
    VerifySchema.parse(await readJson(request, 2_000));
    const target = services.config.productionUrl;
    if (!target) throw new HttpError(422, "Set PRODUCTION_URL to check the production site.");
    const rawResult = await verifyProductionUrl(target);
    const result = {
      ...rawResult,
      title: rawResult.title ? stripControlChars(redact(rawResult.title, services.config.secrets)).slice(0, 200) : null,
    };
    let auditTarget = "invalid-url";
    try {
      auditTarget = new URL(target).host;
    } catch {
      // The verifier returns a safe validation error; never let malformed configuration escape through the audit path.
    }
    await services.audit({
      actor: "owner",
      action: "deploy.verify",
      target: auditTarget,
      result: result.ok ? "ok" : "error",
      detail: result.reason ?? `HTTP ${result.status}`,
    });
    return json(result);
  });
}
