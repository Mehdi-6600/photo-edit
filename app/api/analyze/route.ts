import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { MAX_IDEA_LENGTH, MIN_IDEA_LENGTH, analyzeIdea } from "@/lib/planner";
import { rateLimit, redact } from "@/lib/security";
import { redactPlan } from "@/lib/services";

export const runtime = "nodejs";
export const maxDuration = 60;

const AnalyzeSchema = z.object({
  idea: z.string().trim().min(MIN_IDEA_LENGTH, "needs more detail").max(MAX_IDEA_LENGTH, "is too long"),
});

export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const limit = rateLimit("analyze", 20, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many planning requests. Wait a minute.");
    const { idea } = AnalyzeSchema.parse(await readJson(request, 8_000));
    const safeIdea = redact(idea, services.config.secrets);
    const plan = await analyzeIdea(safeIdea, services.model, services.now());
    return json({ plan: redactPlan(plan, services.config.secrets) });
  });
}
