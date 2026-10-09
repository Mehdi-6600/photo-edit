import { LoginForm } from "@/components/login-form";
import { getServices, accessConfigured } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const locked = !accessConfigured(getServices());
  return <LoginForm next={typeof next === "string" ? next : "/"} locked={locked} />;
}
