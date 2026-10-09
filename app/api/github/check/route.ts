import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";
import { GitHubClient } from "@/lib/github";
import { clientKey, rateLimit, redact, stripControlChars } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Explicit, rate-limited read-only probes. This endpoint never tests permissions with a write. */
export async function POST(request: NextRequest) {
  return withSession(request, { write: true }, async (services) => {
    const limit = rateLimit(`github-probe:${clientKey(request)}`, 3, 60_000);
    if (!limit.allowed) throw new HttpError(429, "Too many GitHub checks. Wait a minute and try again.");
    const token = services.config.githubToken;
    if (!token) throw new HttpError(422, "Add GITHUB_TOKEN in the environment first.");

    const repository = await services.repository();
    if (!repository) {
      let authenticatedAs: string | null = null;
      try {
        authenticatedAs = await new GitHubClient(token, "unknown", "unknown").viewerLogin();
      } catch {
        // Return the failed token probe as a boolean; do not expose provider response text.
      }
      return json({
        repository: null,
        repositoryLocked: Boolean(services.config.githubRepository),
        authenticatedAs,
        probes: null,
        writePermissionsProbed: false,
      });
    }

    const client = services.githubFor(repository.owner, repository.name);
    if (!client) throw new HttpError(403, "The selected repository is outside the configured repository lock.");
    const probes = await client.probePermissions();
    const safeProbes = {
      ...probes,
      authenticatedAs: probes.authenticatedAs ? stripControlChars(redact(probes.authenticatedAs, services.config.secrets)).slice(0, 120) : null,
      defaultBranch: probes.defaultBranch ? stripControlChars(redact(probes.defaultBranch, services.config.secrets)).slice(0, 120) : null,
    };
    await services.audit({
      actor: "owner",
      action: "github.permission_probe",
      target: `${repository.owner}/${repository.name}`,
      result: probes.repositoryReadable ? "ok" : "error",
    });
    return json({
      repository: `${repository.owner}/${repository.name}`,
      repositoryLocked: Boolean(services.config.githubRepository),
      authenticatedAs: safeProbes.authenticatedAs,
      probes: safeProbes,
      writePermissionsProbed: false,
    });
  });
}
