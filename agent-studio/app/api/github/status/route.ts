import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { GitHubClient } from "@/lib/github";
import { redact } from "@/lib/security";
import { REPO_SETTING_KEY } from "@/lib/services";

export const runtime = "nodejs";

/** Verifies the token and repository access. Returns booleans and public names only, never the token. */
export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const repository = await services.repository();
    const repositorySource = repository
      ? (await services.store.getValue(REPO_SETTING_KEY)) ? "ui" : "environment"
      : null;
    const base = {
      tokenConfigured: Boolean(services.config.githubToken),
      repository: repository ? `${repository.owner}/${repository.name}` : null,
      repositorySource,
      viewer: null as string | null,
      access: null as { read: boolean; push: boolean; admin: boolean } | null,
      defaultBranch: null as string | null,
      error: null as string | null,
    };
    if (!services.config.githubToken) return json(base);
    try {
      const client = new GitHubClient(services.config.githubToken, repository?.owner ?? "unknown", repository?.name ?? "unknown");
      base.viewer = await client.viewerLogin();
      if (repository) {
        const info = await services.githubFor(repository.owner, repository.name)?.getRepo();
        if (info) {
          base.access = { read: true, push: info.permissions.push, admin: info.permissions.admin };
          base.defaultBranch = info.defaultBranch;
        }
      }
    } catch (error) {
      base.error = redact((error as Error).message, services.config.secrets);
    }
    return json(base);
  });
}
