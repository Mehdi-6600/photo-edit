import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { OVERRIDES_KEY, fetchLiveStatus, loadRegistry, type OverrideMap } from "@/lib/registry";
import { redact } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Re-reads maintenance facts (archive state, last push, latest release) from GitHub's public API. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const registry = loadRegistry();
    const overrides = (await services.store.getValue<OverrideMap>(OVERRIDES_KEY)) ?? {};
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const agent of registry.agents) {
      try {
        const live = await fetchLiveStatus(agent.repo, fetch, services.config.githubToken, services.now());
        overrides[agent.id] = { ...overrides[agent.id], live };
        results.push({ id: agent.id, ok: true });
      } catch (error) {
        const message = redact((error as Error).message, services.config.secrets).slice(0, 160);
        results.push({ id: agent.id, ok: false, error: message });
      }
    }
    await services.store.setValue(OVERRIDES_KEY, overrides);
    await services.audit({
      actor: "owner",
      action: "registry.revalidate",
      result: results.every((item) => item.ok) ? "ok" : "error",
      detail: `${results.filter((item) => item.ok).length}/${results.length} checked`,
    });
    return json({ checkedAt: services.now().toISOString(), results });
  });
}
