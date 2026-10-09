import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { OVERRIDES_KEY, effectiveAgents, loadRegistry, type OverrideMap } from "@/lib/registry";
import { summarizeTeam } from "@/lib/team";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const registry = loadRegistry();
    const overrides = (await services.store.getValue<OverrideMap>(OVERRIDES_KEY)) ?? {};
    const agents = effectiveAgents(registry, overrides, services.now());
    const runs = await services.store.listRuns(100);
    const repository = await services.repository();
    const roles = summarizeTeam({
      modelConfigured: Boolean(services.model),
      githubConfigured: Boolean(services.config.githubToken && repository),
      agents,
      runs,
    });
    return json({
      storage: services.store.kind,
      modelConfigured: Boolean(services.model),
      githubConfigured: Boolean(services.config.githubToken && repository),
      roles,
    });
  });
}
