import { json } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/security";

export const runtime = "nodejs";

export async function POST() {
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
