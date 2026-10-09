import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { type DeploymentSummary, listVercelDeployments } from "@/lib/deploy";
import { assertPublicHttpsUrl, redact, stripControlChars } from "@/lib/security";

export const runtime = "nodejs";

/** Presence flags and public URLs only. Hook URLs and tokens are never returned. */
export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const { vercel, productionUrl } = services.config;
    let safeProductionUrl: string | null = null;
    let productionUrlError: string | null = null;
    if (productionUrl) {
      try {
        safeProductionUrl = assertPublicHttpsUrl(productionUrl).toString();
      } catch {
        productionUrlError = "PRODUCTION_URL is not a safe public HTTPS URL.";
      }
    }
    const base = {
      tokenConfigured: Boolean(vercel.token),
      projectConfigured: Boolean(vercel.projectId),
      hookConfigured: Boolean(vercel.hookUrl),
      productionUrl: safeProductionUrl,
      deployments: [] as DeploymentSummary[],
      error: productionUrlError,
    };
    if (vercel.token && vercel.projectId) {
      try {
        base.deployments = await listVercelDeployments({
          token: vercel.token,
          projectId: vercel.projectId,
          teamId: vercel.teamId,
        });
      } catch (error) {
        base.error = [base.error, stripControlChars(redact((error as Error).message, services.config.secrets)).slice(0, 300)].filter(Boolean).join(" ").slice(0, 500);
      }
    }
    return json(base);
  });
}
