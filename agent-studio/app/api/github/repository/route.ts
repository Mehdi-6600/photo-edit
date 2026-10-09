import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { parseRepoSlug, GitHubClient } from "@/lib/github";
import { REPO_SETTING_KEY } from "@/lib/services";

export const runtime = "nodejs";

const RepoSchema = z.object({ repository: z.string().trim().min(3).max(140) });

/** Selects the target repository. The token must be able to read it; the choice is stored, not the token. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    if (!services.config.githubToken) throw new HttpError(422, "Add GITHUB_TOKEN in the environment first.");
    const { repository } = RepoSchema.parse(await readJson(request, 1_000));
    const slug = parseRepoSlug(repository);
    if (!slug) throw new HttpError(400, "Use the owner/name format.");
    const client = new GitHubClient(services.config.githubToken, slug.owner, slug.name);
    const info = await client.getRepo();
    await services.store.setValue(REPO_SETTING_KEY, { owner: slug.owner, name: slug.name });
    await services.audit({ actor: "owner", action: "github.repository", target: info.fullName, result: "ok" });
    return json({ repository: info.fullName, defaultBranch: info.defaultBranch, access: info.permissions });
  });
}
