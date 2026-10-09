import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { triggerDeployHook } from "@/lib/deploy";

export const runtime = "nodejs";
export const maxDuration = 60;

const HookSchema = z.object({ confirm: z.string().max(20) });

/** Production deploys need the owner to type DEPLOY. The hook URL is read from the environment and never returned. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const { confirm } = HookSchema.parse(await readJson(request, 1_000));
    if (confirm.trim() !== "DEPLOY") throw new HttpError(422, "Type DEPLOY exactly to confirm the production deploy.");
    const hookUrl = services.config.vercel.hookUrl;
    if (!hookUrl) throw new HttpError(422, "VERCEL_DEPLOY_HOOK_URL is not set.");
    const result = await triggerDeployHook(hookUrl);
    await services.audit({
      actor: "owner",
      action: "deploy.hook",
      target: "production",
      result: result.ok ? "ok" : "error",
      detail: `HTTP ${result.status}`,
    });
    if (!result.ok) throw new HttpError(502, `The deploy hook returned HTTP ${result.status}.`);
    return json({ ok: true, status: result.status });
  });
}
