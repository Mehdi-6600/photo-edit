#!/usr/bin/env node
/**
 * Re-checks the maintenance facts in data/agents.json against GitHub's public REST API.
 *
 *   node scripts/verify-registry.mjs            # print a report
 *   node scripts/verify-registry.mjs --write    # also update maintenance fields and researchedAt
 *
 * Only maintenance data is updated (archive state, last push, latest release, open issues).
 * License, free-use classes and integration claims are reviewed by hand and must be re-read
 * from each project's own README or LICENSE before changing.
 * Set GITHUB_TOKEN to avoid the 60-requests-per-hour anonymous limit.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "..", "data", "agents.json");
const write = process.argv.includes("--write");
const token = process.env.GITHUB_TOKEN;
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "agent-studio-registry-check",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const registry = JSON.parse(await readFile(file, "utf8"));
const today = new Date().toISOString().slice(0, 10);
let failures = 0;

for (const agent of registry.agents) {
  try {
    const repoResponse = await fetch(`https://api.github.com/repos/${agent.repo}`, { headers });
    if (!repoResponse.ok) throw new Error(`repo HTTP ${repoResponse.status}`);
    const repo = await repoResponse.json();
    let latestRelease = "none";
    let latestReleaseAt = null;
    const releaseResponse = await fetch(`https://api.github.com/repos/${agent.repo}/releases/latest`, { headers });
    if (releaseResponse.ok) {
      const release = await releaseResponse.json();
      latestRelease = release.tag_name;
      latestReleaseAt = release.published_at ? release.published_at.slice(0, 10) : null;
    }
    const next = {
      archived: Boolean(repo.archived),
      pushedAt: repo.pushed_at ? repo.pushed_at.slice(0, 10) : null,
      latestRelease,
      latestReleaseAt,
      openIssues: repo.open_issues_count ?? 0,
    };
    const flags = [
      next.archived ? "ARCHIVED" : "",
      repo.license?.spdx_id && repo.license.spdx_id !== agent.license.spdx ? `LICENSE ${repo.license.spdx_id} (registry: ${agent.license.spdx})` : "",
    ].filter(Boolean);
    console.log(`${agent.id.padEnd(16)} ${String(next.pushedAt).padEnd(11)} ${next.latestRelease.padEnd(24)} ${flags.join("; ")}`);
    if (write) agent.maintenance = next;
  } catch (error) {
    failures += 1;
    console.log(`${agent.id.padEnd(16)} ERROR ${error.message}`);
  }
}

if (write) {
  registry.researchedAt = today;
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(`Updated ${path.relative(process.cwd(), file)} (${today}).`);
}
process.exitCode = failures > 0 ? 1 : 0;
