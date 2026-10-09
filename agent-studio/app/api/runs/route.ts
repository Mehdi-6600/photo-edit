import { type NextRequest } from "next/server";
import { z } from "zod";
import { json, readJson, withSession } from "@/lib/api";
import { MAX_IDEA_LENGTH } from "@/lib/planner";
import { createProjectRun } from "@/lib/services";
import { summarizeRun } from "@/lib/views";
import type { Plan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const PlanSchema = z.object({
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(800),
  idea: z.string().trim().min(12).max(MAX_IDEA_LENGTH),
  language: z.enum(["en", "fa"]),
  assumptions: z.array(z.string().max(300)).max(6),
  questions: z.array(z.string().max(300)).max(3),
  requirements: z
    .array(
      z.object({
        id: z.string().regex(/^R\d{1,2}$/),
        text: z.string().min(5).max(300),
        priority: z.enum(["must", "should", "could"]),
        acceptance: z.array(z.string().min(3).max(300)).min(1).max(6),
      }),
    )
    .min(1)
    .max(20),
  features: z.array(z.string().max(40)).max(20),
  taskNotes: z.record(z.string(), z.string().max(400)),
  planner: z.object({
    mode: z.enum(["heuristic", "model"]),
    model: z.string().max(120).optional(),
    warnings: z.array(z.string().max(400)).max(10),
  }),
  createdAt: z.string().max(40),
});

export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const runs = await services.store.listRuns(50);
    return json({ storage: services.store.kind, runs: runs.map(summarizeRun) });
  });
}

export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const body = (await readJson(request, 40_000)) as { plan?: unknown };
    const plan = PlanSchema.parse(body.plan) as Plan;
    const run = await createProjectRun(services, plan);
    return json({ run: summarizeRun(run), id: run.id }, 201);
  });
}
