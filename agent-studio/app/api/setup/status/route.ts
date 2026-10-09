import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { isStrongAccessToken } from "@/lib/security";
import { REPO_SETTING_KEY } from "@/lib/services";

export const runtime = "nodejs";

/** Booleans only: whether each setting is present. Values are never returned. */
export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const { config, store } = services;
    const stored = await store.getValue(REPO_SETTING_KEY);
    return json({
      accessToken: isStrongAccessToken(config.accessToken),
      githubToken: Boolean(config.githubToken),
      githubRepository: Boolean(stored || config.githubRepository),
      model: Boolean(config.model),
      modelError: config.modelConfigError ?? null,
      vercelToken: Boolean(config.vercel.token),
      vercelProject: Boolean(config.vercel.projectId),
      deployHook: Boolean(config.vercel.hookUrl),
      productionUrl: Boolean(config.productionUrl),
      upstash: store.kind === "upstash",
      storage: store.kind,
      allowMerge: config.allowMerge,
      allowedPaths: config.pathPolicy.allow,
    });
  });
}
