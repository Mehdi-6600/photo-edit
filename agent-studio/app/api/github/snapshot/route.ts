import { type NextRequest } from "next/server";
import { HttpError, json, withSession } from "@/lib/api";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return withSession(request, { write: false }, async (services) => {
    const repository = await services.repository();
    if (!repository) throw new HttpError(422, "No repository selected yet.");
    const client = services.githubFor(repository.owner, repository.name);
    if (!client) throw new HttpError(422, "GITHUB_TOKEN is not configured.");
    return json(await client.snapshot());
  });
}
