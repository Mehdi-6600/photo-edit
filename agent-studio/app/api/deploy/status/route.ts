import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { type DeploymentSummary, listVercelDeployments } from "@/lib/deploy";
import { redact } from "@/lib/security";

export const runtime = "nodejs";

/** Presence flags and public URLs only. Hook URLs and tokens are never returned. */
export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const { vercel, productionUrl } = services.config;
    const base = {
      tokenConfigured: Boolean(vercel.token),
      projectConfigured: Boolean(vercel.projectId),
      hookConfigured: Boolean(vercel.hookUrl),
      productionUrl: productionUrl ?? null,
      deployments: [] as DeploymentSummary[],
      error: null as string | null,
    };
    if (vercel.token && vercel.projectId) {
      try {
        base.deployments = await listVercelDeployments({
          token: vercel.token,
          projectId: vercel.projectId,
          teamId: vercel.teamId,
        });
      } catch (error) {
        base.error = redact((error as Error).message, services.config.secrets).slice(0, 300);
      }
    }
    return json(base);
  });
}
