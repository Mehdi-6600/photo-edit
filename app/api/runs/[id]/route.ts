import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { NotFoundError } from "@/lib/services";
import { assertRunId } from "@/lib/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: false }, async (services) => {
    assertRunId(id);
    const run = await services.store.getRun(id);
    if (!run) throw new NotFoundError("Run not found.");
    return json({ run });
  });
}
