import { type NextRequest } from "next/server";
import { z } from "zod";
import { json, readJson, withSession } from "@/lib/api";
import { controlProjectRun } from "@/lib/services";
import { assertRunId } from "@/lib/store";
import { TASK_IDS } from "@/lib/workflow";
import { summarizeRun } from "@/lib/views";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry", "accept_head"]),
  taskId: z.enum(TASK_IDS).optional(),
});

export async function POST(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: true }, async (services) => {
    assertRunId(id);
    const body = ControlSchema.parse(await readJson(request, 2_000));
    const run = await controlProjectRun(services, id, body.action, body.taskId, "owner");
    return json({ run, summary: summarizeRun(run) });
  });
}
