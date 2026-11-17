import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
  const user = await requireUser("/admin/login");
  if (user.role !== "admin") redirect("/app?notice=admin-only");
  return user;
}
