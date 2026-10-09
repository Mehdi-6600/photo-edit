import { describe, expect, it } from "vitest";
import { ModelClient, ModelError, extractJson, modelConfigFromEnv } from "@/lib/model";
import { analyzeIdea, analyzeIdeaHeuristic, buildClarifiedIdea, detectLanguage, MAX_IDEA_LENGTH } from "@/lib/planner";
import { TASK_IDS, validateWorkflow, workflowOrder, TASKS, type TaskDef } from "@/lib/workflow";

const noSleep = async () => undefined;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("model configuration", () => {
  it("returns null when not configured and rejects insecure remote endpoints", () => {
    expect(modelConfigFromEnv({})).toBeNull();
    expect(() => modelConfigFromEnv({ LLM_BASE_URL: "http://example.com/v1", LLM_MODEL: "m" })).toThrow(/https/);
    expect(() => modelConfigFromEnv({ LLM_BASE_URL: "https://example.com/v1?key=secret", LLM_MODEL: "m" })).toThrow(/credentials/);
    const local = modelConfigFromEnv({ LLM_BASE_URL: "http://localhost:11434/v1/", LLM_MODEL: "qwen2.5-coder" });
    expect(local?.baseUrl).toBe("http://localhost:11434/v1");
    const hosted = modelConfigFromEnv({
      LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      LLM_MODEL: "gemini-2.5-flash",
      LLM_API_KEY: " key ",
    });
    expect(hosted?.apiKey).toBe("key");
    expect(hosted?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });
});

describe("ModelClient", () => {
  const apiKey = "sk-" + "test-secret-value-123456";
  const config = { baseUrl: "https://free.example/v1", apiKey, model: "free-model", timeoutMs: 5000 };

  it("posts an OpenAI-compatible chat request with bearer auth", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init as RequestInit };
        return jsonResponse({ model: "free-model", choices: [{ message: { content: "hello" } }] });
      },
    });
    const result = await client.chat([{ role: "user", content: "hi" }], { maxTokens: 50 });
    expect(result.text).toBe("hello");
    expect(seen?.url).toBe("https://free.example/v1/chat/completions");
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(JSON.parse(String(seen?.init.body)).max_tokens).toBe(50);
  });

  it("retries rate limits and then succeeds", async () => {
    let calls = 0;
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "1" });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    });
    expect((await client.chat([{ role: "user", content: "x" }])).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not follow model endpoint redirects while sending credentials", async () => {
    let redirectMode = "";
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async (_url, init) => {
        redirectMode = String(init?.redirect);
        return new Response("", { status: 302, headers: { location: "https://attacker.example/" } });
      },
    });
    await expect(client.chat([{ role: "user", content: "ping" }], { maxAttempts: 1 })).rejects.toThrow(/HTTP 302/);
    expect(redirectMode).toBe("manual");
  });

  it("honors a one-attempt cap for interactive connectivity checks", async () => {
    let calls = 0;
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: { message: "temporarily unavailable" } }, 503);
      },
    });
    await expect(client.chat([{ role: "user", content: "ping" }], { maxAttempts: 1 })).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(1);
  });

  it("never echoes the API key in error messages", async () => {
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async () => jsonResponse({ error: { message: `bad key ${config.apiKey}` } }, 401),
    });
    const error = await client.chat([{ role: "user", content: "x" }]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).not.toContain(config.apiKey);
    expect((error as Error).message).toContain("[REDACTED]");
  });

  it("treats an empty model reply as an error", async () => {
    const client = new ModelClient(config, {
      sleep: noSleep,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
    });
    await expect(client.chat([{ role: "user", content: "x" }])).rejects.toThrow(/empty/);
  });
});

describe("JSON extraction from free-model replies", () => {
  it("handles code fences, prose and nested braces inside strings", () => {
    expect(extractJson('Sure!\n```json\n{"a": 1, "b": {"c": "}"}}\n```')).toEqual({ a: 1, b: { c: "}" } });
    expect(extractJson('Here you go: {"x": [1, 2]} thanks')).toEqual({ x: [1, 2] });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});

describe("heuristic planner", () => {
  const now = new Date("2026-10-09T00:00:00Z");

  it("derives requirements, questions and labels from the idea", () => {
    const plan = analyzeIdeaHeuristic("Build a multilingual appointment-booking website for a barber shop with login.", now);
    expect(plan.planner.mode).toBe("heuristic");
    expect(plan.planner.warnings.join(" ")).toContain("no AI model");
    expect(plan.features).toEqual(expect.arrayContaining(["booking", "auth", "multilingual"]));
    const ids = plan.requirements.map((req) => req.id);
    expect(ids).toEqual(expect.arrayContaining(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R9"]));
    expect(plan.requirements.every((req) => req.acceptance.length > 0)).toBe(true);
    expect(plan.questions.length).toBeLessThanOrEqual(3);
  });

  it("asks at most essential questions, and only when the idea is too thin", () => {
    const tiny = analyzeIdeaHeuristic("App", now);
    expect(tiny.questions).toEqual(["What should the product do, in one sentence?"]);
    const thin = analyzeIdeaHeuristic("Make an app.", now);
    expect(thin.questions).toEqual(["Who will use this, and what is the single most important thing they do?"]);
    const clear = analyzeIdeaHeuristic("Build a booking site for a dentist where patients pick a free slot and get a text confirmation.", now);
    expect(clear.questions).toEqual([]);
  });

  it("adds owner clarifications to the analysis context within the API length limit", () => {
    const clarified = buildClarifiedIdea("Build a booking site.", ["Who is it for?", "How are users notified?"], ["A small clinic.", "Only by email."]);
    expect(clarified).toContain("Original idea: Build a booking site.");
    expect(clarified).toContain("Owner answer: A small clinic.");
    expect(clarified).toContain("Owner answer: Only by email.");
    expect(buildClarifiedIdea("Build a booking site.", ["Who is it for?"], [" "])).toBe("Build a booking site.");
    expect(buildClarifiedIdea("x".repeat(MAX_IDEA_LENGTH), ["q"], ["a"]).length).toBeLessThanOrEqual(MAX_IDEA_LENGTH);
  });

  it("does not mistake a barber shop for an online store", () => {
    const plan = analyzeIdeaHeuristic("Build an appointment website for a barber shop in Tehran.", now);
    expect(plan.features).not.toContain("payments");
    expect(plan.features).toContain("booking");
  });

  it("detects Persian ideas and adds the RTL requirement", () => {
    const idea = "یک وب‌سایت رزرو نوبت برای آرایشگاه بسازید";
    expect(detectLanguage(idea)).toBe("fa");
    const plan = analyzeIdeaHeuristic(idea, now);
    expect(plan.language).toBe("fa");
    expect(plan.requirements.some((req) => req.text.includes("Persian"))).toBe(true);
  });

  it("falls back to the heuristic planner when the model returns invalid output", async () => {
    const model = {
      model: "free-model",
      chat: async () => ({ text: "I cannot produce JSON today", model: "free-model" }),
    };
    const plan = await analyzeIdea("Build a notes app for students with reminders.", model, now);
    expect(plan.planner.mode).toBe("heuristic");
    expect(plan.planner.warnings.join(" ")).toContain("did not match the plan schema");
  });

  it("accepts a valid model plan and drops unknown task notes", async () => {
    const reply = {
      title: "Student notes",
      summary: "A simple notes app where students save and search notes on their phones.",
      assumptions: ["Notes are private to each student."],
      questions: [],
      requirements: [
        { text: "Students can create and search notes.", priority: "must", acceptance: ["Search returns matching notes."] },
        { text: "Works on small screens.", priority: "must", acceptance: ["No horizontal scrolling at 360 px."] },
        { text: "Reminders are optional.", priority: "could", acceptance: ["Reminder can be disabled."] },
      ],
      taskNotes: { backend: "Use a JSON file store behind API routes.", unknown_task: "ignored" },
    };
    const model = { model: "free-model", chat: async () => ({ text: "```json\n" + JSON.stringify(reply) + "\n```", model: "free-model" }) };
    const plan = await analyzeIdea("Build a notes app for students.", model, now);
    expect(plan.planner.mode).toBe("model");
    expect(plan.planner.model).toBe("free-model");
    expect(plan.requirements.map((req) => req.id)).toEqual(["R1", "R2", "R3"]);
    expect(Object.keys(plan.taskNotes)).toEqual(["backend"]);
  });
});

describe("delivery workflow graph", () => {
  it("is acyclic, references known tasks and orders dependencies first", () => {
    expect(() => validateWorkflow(TASKS)).not.toThrow();
    const order = workflowOrder(TASKS);
    expect(order).toHaveLength(TASK_IDS.length);
    const position = new Map(order.map((id, index) => [id, index]));
    for (const task of TASKS) {
      for (const dep of task.dependsOn) expect(position.get(dep)!).toBeLessThan(position.get(task.id)!);
    }
  });

  it("rejects cycles and unknown dependencies", () => {
    const base = (id: string, dependsOn: string[]): TaskDef => ({
      id: id as TaskDef["id"],
      role: "pm",
      kind: "note",
      title: { en: id, fa: id },
      summary: id,
      dependsOn: dependsOn as TaskDef["dependsOn"],
      maxAttempts: 1,
    });
    expect(() => validateWorkflow([base("research", ["design"]), base("design", ["research"])])).toThrow(/cycle/);
    expect(() => validateWorkflow([base("research", ["nope" as string])])).toThrow(/unknown/);
  });

  it("puts a human approval gate before every merge and deploy", () => {
    const merge = TASKS.find((task) => task.id === "merge");
    const deploy = TASKS.find((task) => task.id === "deploy");
    expect(merge?.dependsOn).toEqual(["approve_merge"]);
    expect(deploy?.dependsOn).toEqual(["approve_deploy"]);
    expect(TASKS.find((task) => task.id === "approve_merge")?.kind).toBe("gate");
    expect(TASKS.find((task) => task.id === "approve_deploy")?.kind).toBe("gate");
  });
});
