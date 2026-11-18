import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveAdminView } from "./admin-view";
import { auth } from "./auth";

export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export async function requireUser(loginPath = "/login") {
  const session = await getSession();
  if (!session) redirect(loginPath);
  return session.user;
}

export async function requireAdmin() {
  const user = await requireUser("/admin");
  if (user.role !== "admin") redirect("/app?notice=admin-only");
  return user;
}

// Viewing tokens never replace authentication cookies or the real admin session.
export async function getMemberSession(request: Request) {
  const session = await getSession();
  if (!session) return null;
  const url = new URL(request.url);
  if (!url.searchParams.has("view")) return { ...session, readOnly: false };
  if (session.user.role !== "admin") return null;
  const target = await resolveAdminView(session.user.id, session.session.id, url.searchParams.get("view") || "");
  if (!target) return null;
  return { ...session, user: { ...session.user, ...target, id: String(target.id), name: String(target.name), email: String(target.email), role: String(target.role) }, readOnly: true };
}
