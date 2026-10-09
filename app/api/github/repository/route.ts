import { type NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, json, readJson, withSession } from "@/lib/api";
import { parseRepoSlug } from "@/lib/github";
import { redact, stripControlChars } from "@/lib/security";
import { REPO_SETTING_KEY } from "@/lib/services";

export const runtime = "nodejs";

const RepoSchema = z.object({ repository: z.string().trim().min(3).max(140) });

/** Selects the target repository. The token must be able to read it; the choice is stored, not the token. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    if (!services.config.githubToken) throw new HttpError(422, "Add GITHUB_TOKEN in the environment first.");
    if (services.config.repositoryConfigError) throw new HttpError(503, services.config.repositoryConfigError);
    const { repository } = RepoSchema.parse(await readJson(request, 1_000));
    const slug = parseRepoSlug(repository);
    if (!slug) throw new HttpError(400, "Use the owner/name format.");
    const locked = services.config.githubRepository;
    if (locked && (slug.owner.toLowerCase() !== locked.owner.toLowerCase() || slug.name.toLowerCase() !== locked.name.toLowerCase())) {
      throw new HttpError(403, "This Agent Studio deployment is locked to the configured repository.");
    }
    const client = services.githubFor(slug.owner, slug.name);
    if (!client) throw new HttpError(403, "The repository is outside the configured repository lock.");
    const info = await client.getRepo();
    if (info.archived) throw new HttpError(422, "Archived repositories cannot be used for code changes.");
    const canonical = parseRepoSlug(info.fullName) ?? slug;
    const fullName = `${canonical.owner}/${canonical.name}`;
    const defaultBranch = stripControlChars(redact(info.defaultBranch, services.config.secrets)).slice(0, 120);
    if (!locked) await services.store.setValue(REPO_SETTING_KEY, canonical);
    await services.audit({ actor: "owner", action: "github.repository", target: fullName, result: "ok" });
    return json({ repository: fullName, defaultBranch, access: info.permissions, locked: Boolean(locked) });
  });
}
