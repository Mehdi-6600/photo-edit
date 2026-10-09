import { z } from "zod";
import registryData from "@/data/agents.json";

export const AgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(80),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  category: z.string().min(1).max(60),
  status: z.enum(["active", "optional", "excluded"]),
  exclusionReason: z.string().max(400).optional(),
  license: z.object({ spdx: z.string().max(40), osi: z.boolean(), note: z.string().max(300).optional() }),
  maintenance: z.object({
    archived: z.boolean(),
    pushedAt: z.string().nullable(),
    latestRelease: z.string(),
    latestReleaseAt: z.string().nullable(),
    openIssues: z.number().int().nonnegative(),
  }),
  freeUse: z.object({ classes: z.array(z.enum(["A", "B", "C", "D", "E"])), note: z.string().max(400) }),
  interfaces: z.array(z.string()),
  integration: z.object({
    verification: z.enum(["installed-and-checked", "docs-only", "not-verified"]),
    verified: z.string().max(600),
    invocation: z.string().max(300).optional(),
  }),
  capabilities: z.array(z.string()),
  roles: z.array(z.string()),
  requirements: z.object({ docker: z.boolean(), gpu: z.boolean(), runtime: z.string().max(200) }),
  risks: z.array(z.string().max(300)),
  adapter: z.object({ status: z.enum(["implemented", "documented", "none"]), note: z.string().max(400) }),
  evidence: z.array(z.object({ claim: z.string().max(300), url: z.string().url() })),
});

export const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  researchedAt: z.string(),
  method: z.string(),
  freeUseClasses: z.record(z.string(), z.string()),
  agents: z.array(AgentSchema).min(1),
});

export type AgentEntry = z.infer<typeof AgentSchema>;
export type Registry = z.infer<typeof RegistrySchema>;

export interface LiveStatus {
  archived: boolean;
  pushedAt: string | null;
  latestRelease: string;
  latestReleaseAt: string | null;
  openIssues: number;
  checkedAt: string;
  error?: string;
}

export interface RegistryOverride {
  enabled?: boolean;
  live?: LiveStatus;
}

export type OverrideMap = Record<string, RegistryOverride>;

export const OVERRIDES_KEY = "registry:overrides";

export function loadRegistry(raw: unknown = registryData): Registry {
  const parsed = RegistrySchema.parse(raw);
  const ids = new Set<string>();
  for (const agent of parsed.agents) {
    if (ids.has(agent.id)) throw new Error(`Duplicate registry id: ${agent.id}`);
    ids.add(agent.id);
  }
  return parsed;
}

export interface EffectiveAgent extends AgentEntry {
  enabled: boolean;
  live?: LiveStatus;
  score: number | null;
  scoreBreakdown: { label: string; points: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, (now.getTime() - time) / DAY_MS);
}

/**
 * Transparent, documented scoring. Stars are deliberately not an input.
 * Maintenance 30, release recency 10, free-use 25, integration 15, coding capability 15, penalties up to -10.
 * Agents that are archived, not OSI open source, or excluded are not scored (null).
 */
export function scoreAgent(agent: AgentEntry, now: Date = new Date()): { score: number | null; breakdown: { label: string; points: number }[] } {
  if (agent.status === "excluded" || agent.maintenance.archived || !agent.license.osi) {
    return { score: null, breakdown: [{ label: "Excluded from ranking", points: 0 }] };
  }
  const breakdown: { label: string; points: number }[] = [];

  const pushAge = daysSince(agent.maintenance.pushedAt, now);
  const maintenance = pushAge === null ? 0 : pushAge <= 30 ? 30 : pushAge <= 90 ? 24 : pushAge <= 180 ? 18 : pushAge <= 365 ? 10 : 0;
  breakdown.push({ label: "Maintenance (last code push)", points: maintenance });

  const releaseAge = daysSince(agent.maintenance.latestReleaseAt, now);
  const release = releaseAge === null ? 0 : releaseAge <= 180 ? 10 : releaseAge <= 365 ? 6 : releaseAge <= 730 ? 2 : 0;
  breakdown.push({ label: "Release recency", points: release });

  // Operating cost: zero only if a no-cost path exists (local weights, free inference or a free tier).
  const zeroCostViable = agent.freeUse.classes.some((item) => item === "B" || item === "C" || item === "E");
  const cost = zeroCostViable ? Math.min(25, agent.freeUse.classes.length * 5) : 0;
  breakdown.push({ label: "Zero-cost path (free-use classes)", points: cost });

  const interfaceScore = agent.interfaces.includes("cli-headless")
    ? 12
    : agent.interfaces.some((item) => item === "sdk" || item === "library" || item === "agent-server")
      ? 6
      : agent.interfaces.includes("cli-interactive")
        ? 6
        : agent.interfaces.some((item) => item === "ide" || item === "web-ui")
          ? 3
          : 0;
  const verificationScore = agent.integration.verification === "installed-and-checked" ? 8 : agent.integration.verification === "docs-only" ? 4 : 0;
  const integration = Math.min(20, interfaceScore + verificationScore);
  breakdown.push({ label: "Unattended integration and verification", points: integration });

  const capability = Math.min(
    15,
    (agent.capabilities.includes("code-edit") ? 8 : 0) +
      (agent.capabilities.includes("run-tests") ? 4 : 0) +
      (agent.capabilities.includes("shell-commands") ? 3 : 0),
  );
  breakdown.push({ label: "Coding capability", points: capability });

  let penalty = 0;
  if (agent.requirements.docker) penalty -= 5;
  if (agent.requirements.gpu) penalty -= 5;
  if (penalty < 0) breakdown.push({ label: "Heavy setup", points: penalty });

  const total = Math.max(0, Math.min(100, maintenance + release + cost + integration + capability + penalty));
  return { score: total, breakdown };
}

export function effectiveAgents(
  registry: Registry,
  overrides: OverrideMap,
  now: Date = new Date(),
): EffectiveAgent[] {
  return registry.agents.map((agent) => {
    const override = overrides[agent.id];
    const live = override?.live;
    const merged: AgentEntry = live
      ? {
          ...agent,
          maintenance: {
            archived: live.archived,
            pushedAt: live.pushedAt,
            latestRelease: live.latestRelease,
            latestReleaseAt: live.latestReleaseAt,
            openIssues: live.openIssues,
          },
        }
      : agent;
    const { score, breakdown } = scoreAgent(merged, now);
    return {
      ...merged,
      enabled: override?.enabled ?? agent.status === "active",
      live,
      score,
      scoreBreakdown: breakdown,
    };
  });
}

export function rankAgents(agents: EffectiveAgent[]): EffectiveAgent[] {
  return [...agents].sort((a, b) => {
    const left = a.score ?? -1;
    const right = b.score ?? -1;
    if (right !== left) return right - left;
    return a.name.localeCompare(b.name);
  });
}

/** Agents that serve a given role, restricted to those enabled in the team. */
export function agentsForRole(agents: EffectiveAgent[], role: string): EffectiveAgent[] {
  return agents.filter((agent) => agent.enabled && agent.roles.includes(role) && agent.status !== "excluded");
}

/** Computes the live maintenance fields for one agent from GitHub's public REST API. */
export async function fetchLiveStatus(
  repo: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
  now: Date = new Date(),
): Promise<LiveStatus> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-studio-registry",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const checkedAt = now.toISOString();
  const repoResponse = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!repoResponse.ok) {
    throw new Error(`GitHub returned ${repoResponse.status} for ${repo}`);
  }
  const data = (await repoResponse.json()) as {
    archived: boolean;
    pushed_at: string | null;
    open_issues_count: number;
  };
  let latestRelease = "none";
  let latestReleaseAt: string | null = null;
  const releaseResponse = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (releaseResponse.ok) {
    const release = (await releaseResponse.json()) as { tag_name: string; published_at: string | null };
    latestRelease = release.tag_name;
    latestReleaseAt = release.published_at ? release.published_at.slice(0, 10) : null;
  }
  return {
    archived: data.archived,
    pushedAt: data.pushed_at ? data.pushed_at.slice(0, 10) : null,
    latestRelease,
    latestReleaseAt,
    openIssues: data.open_issues_count,
    checkedAt,
  };
}
