import { type NextRequest } from "next/server";
import { json, withSession } from "@/lib/api";
import { NotFoundError } from "@/lib/services";
import { redact } from "@/lib/security";
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
    const base = {
      branch: run.branch ?? null,
      headSha: run.headSha ?? null,
      baseSha: run.baseSha ?? null,
      pr: run.pr ?? null,
      approvals: run.approvals,
      reviewOutput: run.tasks.review.output ?? null,
      reviewError: run.tasks.review.error ?? null,
      auditOutput: run.tasks.audit.output ?? null,
      auditError: run.tasks.audit.error ?? null,
    };
    const github = run.repo ? services.githubFor(run.repo.owner, run.repo.name) : null;
    if (!github || !run.repo) {
      return json({ ...base, connected: false, files: [], checks: [] });
    }

    const secrets = services.config.secrets;
    const files =
      run.baseSha && run.headSha && run.headSha !== run.baseSha
        ? (await github.compare(run.baseSha, run.headSha)).files.map((file) => ({
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch ? redact(file.patch, secrets).slice(0, MAX_PATCH_CHARS) : null,
            patchTruncated: Boolean(file.patch && file.patch.length > MAX_PATCH_CHARS),
          }))
        : [];
    const checks = run.headSha ? await github.checkRuns(run.headSha) : [];
    return json({
      ...base,
      connected: true,
      files,
      checks: checks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.url })),
    });
  });
}
