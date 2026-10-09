import { json } from "@/lib/api";

export const runtime = "nodejs";

/** Public liveness check. Returns no configuration details. */
export async function GET() {
  return json({ ok: true, time: new Date().toISOString() });
}
