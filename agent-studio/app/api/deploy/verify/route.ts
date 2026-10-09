import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { verifyProductionUrl } from "@/lib/deploy";

export const runtime = "nodejs";
export const maxDuration = 60;

const VerifySchema = z.object({ url: z.string().trim().max(300).optional() });

/** Makes a real request to the production URL. Only public https URLs are accepted. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const { url } = VerifySchema.parse(await readJson(request, 2_000));
    const target = url || services.config.productionUrl;
    if (!target) throw new HttpError(422, "Set PRODUCTION_URL or enter a URL to check.");
    const result = await verifyProductionUrl(target);
    await services.audit({
      actor: "owner",
      action: "deploy.verify",
      target: new URL(target.startsWith("http") ? target : `https://${target}`).host,
      result: result.ok ? "ok" : "error",
      detail: result.reason ?? `HTTP ${result.status}`,
    });
    return json(result);
  });
}
