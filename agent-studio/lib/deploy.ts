import { assertPublicHttpsUrl, redact } from "./security";

export interface DeploymentSummary {
  id: string;
  url: string;
  state: string;
  target: string | null;
  createdAt: string;
}

export interface VerifyResult {
  ok: boolean;
  status: number | null;
  title: string | null;
  durationMs: number;
  checkedAt: string;
  reason?: string;
}

export function validateDeployHookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The deploy hook URL is not valid.");
  }
  if (url.protocol !== "https:" || url.hostname !== "api.vercel.com" || !url.pathname.startsWith("/v1/integrations/deploy/")) {
    throw new Error("The deploy hook must be a Vercel deploy hook URL (api.vercel.com/v1/integrations/deploy/...).");
  }
  return url;
}

export async function listVercelDeployments(
  config: { token: string; projectId: string; teamId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentSummary[]> {
  const params = new URLSearchParams({ projectId: config.projectId, limit: "5" });
  if (config.teamId) params.set("teamId", config.teamId);
  const response = await fetchImpl(`https://api.vercel.com/v6/deployments?${params.toString()}`, {
    headers: { Authorization: `Bearer ${config.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json().catch(() => null)) as
    | { deployments?: { uid: string; url: string; state?: string; target?: string | null; created: number }[]; error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(redact(`Vercel returned ${response.status}: ${data?.error?.message ?? response.statusText}`, [config.token]));
  }
  return (data?.deployments ?? []).map((item) => ({
    id: item.uid,
    url: `https://${item.url}`,
    state: item.state ?? "UNKNOWN",
    target: item.target ?? null,
    createdAt: new Date(item.created).toISOString(),
  }));
}

export async function triggerDeployHook(
  hookUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = validateDeployHookUrl(hookUrl);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  return { ok: response.ok, status: response.status };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Performs a real GET against a public HTTPS URL. Success requires HTTP 200 and an HTML document. */
export async function verifyProductionUrl(raw: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const started = Date.now();
  const checkedAt = new Date(started).toISOString();
  let url: URL;
  try {
    url = assertPublicHttpsUrl(raw);
  } catch (error) {
    return { ok: false, status: null, title: null, durationMs: 0, checkedAt, reason: (error as Error).message };
  }
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "text/html", "User-Agent": "agent-studio-verify" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const body = await readLimited(response, 128 * 1024);
    const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(body)?.[1]?.trim() ?? null;
    const isHtml = /<html[\s>]/i.test(body);
    const ok = response.status === 200 && isHtml;
    return {
      ok,
      status: response.status,
      title,
      durationMs: Date.now() - started,
      checkedAt,
      reason: ok ? undefined : response.status !== 200 ? `HTTP ${response.status}` : "Response is not an HTML page",
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "Timed out after 15 seconds" : "Request failed";
    return { ok: false, status: null, title: null, durationMs: Date.now() - started, checkedAt, reason };
  }
}
