import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { NotFoundError } from "@/lib/services";
import { redact, stripControlChars } from "@/lib/security";
import { assertRunId } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const MAX_PATCH_CHARS = 6000;

/** Read-only review view: diff against the base commit plus live CI check results. */
export async function GET(request: NextRequest, context: Params) {
  const { id } = await context.params;
  return withSession(request, { write: false }, async (services) => {
    assertRunId(id);
    const run = await services.store.getRun(id);
    if (!run) throw new NotFoundError("Run not found.");
    const safe = (value: string | undefined, max: number) =>
      value ? stripControlChars(redact(value, services.config.secrets)).slice(0, max) : null;
    const base = {
      branch: safe(run.branch, 200),
      headSha: safe(run.headSha, 64),
      baseSha: safe(run.baseSha, 64),
      pr: run.pr ? { ...run.pr, url: safe(run.pr.url, 300) ?? "" } : null,
      approvals: run.approvals,
      reviewOutput: safe(run.tasks.review.output, 8_000),
      reviewError: safe(run.tasks.review.error, 2_000),
      auditOutput: safe(run.tasks.audit.output, 8_000),
      auditError: safe(run.tasks.audit.error, 2_000),
    };
    const github = run.repo ? services.githubFor(run.repo.owner, run.repo.name) : null;
    if (!github || !run.repo) {
      return json({ ...base, connected: false, files: [], checks: [] });
    }

    const files =
      run.baseSha && run.headSha && run.headSha !== run.baseSha
        ? (await github.compare(run.baseSha, run.headSha)).files.map((file) => ({
            path: safe(file.path, 200) ?? "",
            status: safe(file.status, 40) ?? "unknown",
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch ? safe(file.patch, MAX_PATCH_CHARS) : null,
            patchTruncated: Boolean(file.patch && file.patch.length > MAX_PATCH_CHARS),
          }))
        : [];
    const checks = run.headSha ? await github.checkRuns(run.headSha) : [];
    return json({
      ...base,
      connected: true,
      files,
      checks: checks.map((check) => ({
        name: safe(check.name, 160) ?? "unnamed",
        status: safe(check.status, 40) ?? "unknown",
        conclusion: check.conclusion ? safe(check.conclusion, 40) : null,
        url: safe(check.url, 500) ?? "",
      })),
    });
  });
}
