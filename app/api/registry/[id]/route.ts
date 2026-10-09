import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { NotFoundError } from "@/lib/services";
import { OVERRIDES_KEY, loadRegistry, type OverrideMap } from "@/lib/registry";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const ToggleSchema = z.object({ enabled: z.boolean() });

/** Adds or removes an agent from the team. Excluded agents can never be enabled. */
export async function PATCH(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: true }, async (services) => {
    const registry = loadRegistry();
    const agent = registry.agents.find((item) => item.id === id);
    if (!agent) throw new NotFoundError("Unknown agent.");
    if (agent.status === "excluded") {
      throw new HttpError(422, "This agent is excluded because it is not zero-cost or open source. It cannot join the team.");
    }
    const { enabled } = ToggleSchema.parse(await readJson(request, 1_000));
    const overrides = (await services.store.getValue<OverrideMap>(OVERRIDES_KEY)) ?? {};
    overrides[id] = { ...overrides[id], enabled };
    await services.store.setValue(OVERRIDES_KEY, overrides);
    await services.audit({ actor: "owner", action: "registry.toggle", target: id, result: "ok", detail: enabled ? "enabled" : "disabled" });
    return json({ id, enabled });
  });
}
