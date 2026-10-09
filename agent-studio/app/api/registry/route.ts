import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { OVERRIDES_KEY, effectiveAgents, loadRegistry, rankAgents, type OverrideMap } from "@/lib/registry";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const registry = loadRegistry();
    const overrides = (await services.store.getValue<OverrideMap>(OVERRIDES_KEY)) ?? {};
    const agents = rankAgents(effectiveAgents(registry, overrides, services.now()));
    const lastRevalidatedAt = Object.values(overrides)
      .map((item) => item.live?.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    return json({
      researchedAt: registry.researchedAt,
      method: registry.method,
      freeUseClasses: registry.freeUseClasses,
      lastRevalidatedAt,
      agents,
    });
  });
}
