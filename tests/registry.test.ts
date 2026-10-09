import { describe, expect, it } from "vitest";
import { agentsForRole, effectiveAgents, loadRegistry, rankAgents, scoreAgent } from "@/lib/registry";
import { summarizeTeam, TEAM_ROLES } from "@/lib/team";
import type { Run } from "@/lib/types";
import { analyzeIdeaHeuristic } from "@/lib/planner";
import { createRun } from "@/lib/engine";
import { FixedClock } from "./helpers/fakes";

const NOW = new Date("2026-10-09T12:00:00Z");

describe("verified agent registry", () => {
  const registry = loadRegistry();

  it("contains only entries with evidence links and a documented license", () => {
    for (const agent of registry.agents) {
      expect(agent.evidence.length, agent.id).toBeGreaterThan(0);
      for (const item of agent.evidence) expect(item.url.startsWith("https://"), agent.id).toBe(true);
      expect(agent.license.spdx.length, agent.id).toBeGreaterThan(0);
    }
  });

  it("keeps the active team strictly free, open source and maintained", () => {
    const active = registry.agents.filter((agent) => agent.status === "active");
    expect(active.length).toBeGreaterThan(0);
    for (const agent of active) {
      expect(agent.license.osi, agent.id).toBe(true);
      expect(agent.maintenance.archived, agent.id).toBe(false);
      expect(agent.freeUse.classes.length, agent.id).toBeGreaterThan(0);
      expect(agent.freeUse.classes, agent.id).not.toContain("D");
      expect(agent.requirements.docker, agent.id).toBe(false);
      expect(agent.interfaces, agent.id).toContain("cli-headless");
      const pushed = Date.parse(agent.maintenance.pushedAt ?? "");
      expect(NOW.getTime() - pushed, agent.id).toBeLessThan(365 * 24 * 3600 * 1000);
    }
  });

  it("excludes archived, non-OSI and stale projects with a stated reason", () => {
    const excluded = registry.agents.filter((agent) => agent.status === "excluded");
    expect(excluded.map((agent) => agent.id)).toEqual(expect.arrayContaining(["roo-code", "gpt-engineer", "claude-code", "gpt-pilot"]));
    for (const agent of excluded) {
      expect(agent.exclusionReason, agent.id).toBeTruthy();
      expect(scoreAgent(agent, NOW).score, agent.id).toBeNull();
    }
  });

  it("marks paid-only tools as optional upgrades, not zero-cost team members", () => {
    const codex = registry.agents.find((agent) => agent.id === "codex-cli");
    expect(codex?.status).toBe("optional");
    expect(codex?.freeUse.note).toContain("NOT zero-cost");
  });

  it("ranks without using stars: the score has only documented criteria", () => {
    const agent = registry.agents.find((item) => item.id === "aider");
    expect(agent).toBeDefined();
    const { breakdown } = scoreAgent(agent!, NOW);
    expect(breakdown.map((part) => part.label)).toEqual([
      "Maintenance (last code push)",
      "Release recency",
      "Zero-cost path (free-use classes)",
      "Unattended integration and verification",
      "Coding capability",
    ]);
    expect(breakdown.reduce((sum, part) => sum + part.points, 0)).toBe(agent && scoreAgent(agent, NOW).score);
    const ranked = rankAgents(effectiveAgents(registry, {}, NOW));
    const scores = ranked.map((item) => item.score ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("counts a verification level, not just a README claim, in integration", () => {
    const verified = registry.agents.find((item) => item.id === "aider");
    const docsOnly = registry.agents.find((item) => item.id === "gemini-cli");
    expect(verified?.integration.verification).toBe("installed-and-checked");
    expect(docsOnly?.integration.verification).toBe("docs-only");
    const pick = (agent: typeof verified, level: string) => scoreAgent({ ...agent!, integration: { ...agent!.integration, verification: level as never } }, NOW).breakdown.find((part) => part.label.startsWith("Unattended"))?.points;
    expect(pick(verified, "installed-and-checked")).toBeGreaterThan(pick(verified, "docs-only") ?? 0);
    expect(pick(verified, "docs-only")).toBeGreaterThan(pick(verified, "not-verified") ?? 0);
  });

  it("uses only verified adapter claims for implemented or documented integrations", () => {
    const documented = registry.agents.filter((agent) => agent.adapter.status === "documented");
    expect(documented.map((agent) => agent.id)).toEqual(expect.arrayContaining(["aider", "mini-swe-agent", "gemini-cli", "qwen-code"]));
    for (const agent of documented) {
      expect(agent.integration.verified.length, agent.id).toBeGreaterThan(20);
    }
  });

  it("maps roles to registry agents that exist and cover the roles that need them", () => {
    const ids = new Set(registry.agents.map((agent) => agent.id));
    for (const role of TEAM_ROLES) {
      for (const id of role.agentIds) expect(ids.has(id), `${role.id} -> ${id}`).toBe(true);
    }
    const effective = effectiveAgents(registry, {}, NOW);
    expect(agentsForRole(effective, "debugging").map((agent) => agent.id)).toContain("mini-swe-agent");
    expect(agentsForRole(effective, "frontend").map((agent) => agent.id)).toContain("aider");
  });

  it("applies live GitHub overrides without changing the verified evidence", () => {
    const override = {
      "mini-swe-agent": {
        enabled: false,
        live: { archived: true, pushedAt: "2026-01-01", latestRelease: "v9", latestReleaseAt: "2026-01-01", openIssues: 3, checkedAt: NOW.toISOString() },
      },
    };
    const merged = effectiveAgents(registry, override, NOW).find((agent) => agent.id === "mini-swe-agent");
    expect(merged?.enabled).toBe(false);
    expect(merged?.maintenance.archived).toBe(true);
    expect(merged?.score).toBeNull();
    expect(registry.agents.find((agent) => agent.id === "mini-swe-agent")?.maintenance.archived).toBe(false);
  });
});

describe("team status", () => {
  const plan = analyzeIdeaHeuristic("Build a simple notes app for students with login and notifications.", NOW);
  const clock = new FixedClock(NOW.toISOString());

  it("shows available, configured and executed separately", () => {
    const agents = effectiveAgents(loadRegistry(), {}, NOW);
    const none = summarizeTeam({ modelConfigured: false, githubConfigured: false, agents, runs: [] });
    expect(none.find((role) => role.id === "frontend")?.status).toBe("available");
    expect(none.find((role) => role.id === "pm")?.status).toBe("configured");

    const configured = summarizeTeam({ modelConfigured: true, githubConfigured: true, agents, runs: [] });
    expect(configured.find((role) => role.id === "frontend")?.status).toBe("configured");

    const run: Run = createRun(plan, { id: "r-team-01", now: clock.now(), repo: undefined });
    run.tasks.research.status = "succeeded";
    run.tasks.research.finishedAt = NOW.toISOString();
    const executed = summarizeTeam({ modelConfigured: true, githubConfigured: true, agents, runs: [run] });
    const research = executed.find((role) => role.id === "research");
    expect(research?.status).toBe("executed");
    expect(research?.executedCount).toBe(1);
  });
});
