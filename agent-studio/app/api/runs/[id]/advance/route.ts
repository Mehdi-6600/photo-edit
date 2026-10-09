import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";
import { advanceProjectRun } from "@/lib/services";
import { rateLimit } from "@/lib/security";
import { assertRunId } from "@/lib/store";
import { summarizeRun } from "@/lib/views";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: true }, async (services) => {
    assertRunId(id);
    const limit = rateLimit(`advance:${id}`, 60, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many steps requested. Wait a moment.");
    const result = await advanceProjectRun(services, id, "owner");
    return json({ run: result.run, summary: summarizeRun(result.run), didWork: result.didWork, message: result.message });
  });
}
