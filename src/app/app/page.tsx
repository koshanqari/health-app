import Link from "next/link";
import { MemberTabs } from "@/components/member-tabs";
import { redirect } from "next/navigation";
import { getSession, requireUser } from "@/lib/session";
import { resolveAdminView } from "@/lib/admin-view";
import { AppIcon, type AppTab } from "@/components/app-header";
import { db, type DatabaseRow } from "@/lib/db";
import type { ProfileAvatarId, ProfileSex } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your space" };

const features = [
  { id: "food" as const, title: "Food journal", copy: "A place for the meals that make you feel good.", heading: "Your food journal", detail: "Log your meals and nutrition, and look back at your day." },
  { id: "activity" as const, title: "Movement you love", copy: "A walk, a stretch, a little more room to move.", heading: "Your activity", detail: "A place for your walks, workouts, and everyday movement. Log your walks, games and workouts." },
  { id: "progress" as const, title: "Your small beginnings", copy: "See how your everyday efforts add up.", heading: "Your progress", detail: "Your daily goals and monthly milestones will live here. Progress tracking is coming soon." },
];

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; tab?: string; profile?: string; view?: string }> }) {
  const params = await searchParams;
  let user = await requireUser();
  let viewingAs = null;
  if (params.view !== undefined) {
    const session = await getSession();
    if (!session || session.user.role !== "admin") redirect("/admin");
    const target = await resolveAdminView(session.user.id, session.session.id, params.view);
    if (!target) redirect("/admin?notice=view-ended");
    user = { ...user, ...target, id: String(target.id), name: String(target.name), email: String(target.email), role: target.role === "admin" ? "admin" : "user" };
    viewingAs = { token: params.view, name: String(target.name), expiresAt: String(target.viewExpiresAt) };
  }
  const [profileRows] = await db.execute<DatabaseRow[]>('SELECT "avatarId", age, sex, "heightCm"::double precision AS "heightCm", "weightKg"::double precision AS "weightKg" FROM "userProfile" WHERE "userId" = $1', [user.id]);
  const { notice, tab, profile } = params;
  const feature = features.find(item => item.id === tab);
  const activeTab: AppTab = tab === "chat" ? "chat" : feature?.id ?? "home";

  return <MemberTabs
    viewingAs={viewingAs}
    name={user.name}
    initialAvatarId={(profileRows[0]?.avatarId ?? null) as ProfileAvatarId | null}
    isAdmin={user.role === "admin"}
    initialTab={activeTab}
    initialProfileOpen={profile === "1"}
    notice={notice === "admin-only" ? <div className="notice" role="status">The admin area is only available to administrators. You’re signed in to your member account.</div> : undefined}
    initialProfile={{ age: profileRows[0]?.age ?? null, sex: (profileRows[0]?.sex ?? null) as ProfileSex | null, heightCm: profileRows[0]?.heightCm ?? null, weightKg: profileRows[0]?.weightKg ?? null }}
    progress={<UpcomingFeature id="progress" />}
  />;
}

function UpcomingFeature({ id }: { id: "progress" }) {
  const feature = features.find(item => item.id === id)!;
  return <>
    <p className="eyebrow">Your space / Progress</p>
    <h1>{feature.heading}</h1>
    <section className="tab-placeholder">
      <div className="tab-feature-icon"><AppIcon name={id} /></div>
      <span className="coming-label">Coming soon</span>
      <h2>A little space, just for you.</h2>
      <p>{feature.detail}</p>
      <Link className="primary-button" href="/app" prefetch={false}>Back to home</Link>
    </section>
  </>;
}
