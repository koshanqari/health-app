import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ message: "Sign in to continue." }, { status: 401 });
  return Response.json(
    { user: { id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
