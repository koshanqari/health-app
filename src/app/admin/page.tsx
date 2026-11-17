import type { DatabaseRow } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-header";
import { UserDirectory, type DirectoryUser } from "@/components/user-directory";
import type { ProfileAvatarId } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

export default async function AdminPage() {
  const admin = await requireAdmin();
  const [profileRows] = await db.execute<DatabaseRow[]>('SELECT "avatarId" FROM "userProfile" WHERE "userId" = $1', [admin.id]);
  const [rows] = await db.execute<(DatabaseRow & Omit<DirectoryUser, "createdAt"> & { createdAt: Date })[]>(
    "SELECT id, name, email, role, \"createdAt\" FROM \"user\" ORDER BY \"createdAt\" DESC LIMIT 100",
  );
  const [counts] = await db.execute<DatabaseRow[]>(
    "SELECT COUNT(*)::integer AS total, SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END)::integer AS admins, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END)::integer AS members FROM \"user\"",
  );
  const [sessions] = await db.execute<DatabaseRow[]>(
    "SELECT COUNT(*)::integer AS total FROM \"session\" WHERE \"expiresAt\" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
  );
  const users = rows.map(user => ({
    id: user.id, name: user.name, email: user.email, role: user.role,
    createdAt: new Date(user.createdAt).toISOString(),
  }));
  const metrics = [
    { label: "Members", value: counts[0].members || 0 },
    { label: "Administrators", value: counts[0].admins || 0 },
    { label: "Active sessions", value: sessions[0].total || 0 },
  ];

  return (
    <AppShell name={admin.name} avatarId={(profileRows[0]?.avatarId ?? null) as ProfileAvatarId | null} isAdmin area="admin">
      <main id="main-content" className="workspace-main admin-main">
        <p className="eyebrow">The people behind Daywell</p>
        <h1>Hello, {admin.name.trim().split(/\s+/)[0]}.</h1>
        <p className="page-subtitle">A little care for your Daywell community.</p>
        <dl className="account-stats">
          {metrics.map(({ label, value }) => (
            <div className="account-stat" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <UserDirectory users={users} />
        <p className="account-note">Member meal and activity records stay out of this view.</p>
      </main>
    </AppShell>
  );
}
