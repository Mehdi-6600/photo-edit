import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { approveProjectGate } from "@/lib/services";
import { assertRunId } from "@/lib/store";
import { summarizeRun } from "@/lib/views";
import { TASK_IDS } from "@/lib/workflow";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ApproveSchema = z.object({
  gate: z.enum(TASK_IDS),
  phrase: z.string().max(20),
});

export async function POST(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: true }, async (services) => {
    assertRunId(id);
    const body = ApproveSchema.parse(await readJson(request, 2_000));
    const result = await approveProjectGate(services, id, body.gate, body.phrase, "owner");
    if (!result.ok) throw new HttpError(422, result.message);
    return json({ ok: true, message: result.message, run: result.run, summary: summarizeRun(result.run) });
  });
}
