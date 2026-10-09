import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";
import { redact, stripControlChars } from "@/lib/security";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const repository = await services.repository();
    if (!repository) throw new HttpError(422, "No repository selected yet.");
    const client = services.githubFor(repository.owner, repository.name);
    if (!client) throw new HttpError(422, "GITHUB_TOKEN is not configured.");
    const snapshot = await client.snapshot();
    const safe = (value: string, max: number) => stripControlChars(redact(value, services.config.secrets)).slice(0, max);
    return json({
      repo: {
        fullName: safe(snapshot.repo.fullName, 150),
        defaultBranch: safe(snapshot.repo.defaultBranch, 120),
        htmlUrl: safe(snapshot.repo.htmlUrl, 300),
        archived: snapshot.repo.archived,
      },
      commits: snapshot.commits.map((commit) => ({
        sha: commit.sha,
        message: safe(commit.message, 120),
        author: safe(commit.author, 100),
        date: commit.date,
      })),
      pulls: snapshot.pulls.map((pull) => ({
        number: pull.number,
        title: safe(pull.title, 120),
        url: safe(pull.url, 300),
        head: safe(pull.head, 120),
      })),
      topLevel: snapshot.topLevel.map((path) => safe(path, 120)),
    });
  });
}
