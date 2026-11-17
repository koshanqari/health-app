import { creditSettings } from "@/lib/credits";
import type { DatabaseRow } from "@/lib/db";
import { getSession, requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { AdminWorkspace } from "@/components/admin-workspace";
import { AuthShell } from "@/components/auth-shell";
import { AuthForm } from "@/components/auth-form";
import { UserDirectory, type DirectoryUser } from "@/components/user-directory";
import type { ProfileAvatarId } from "@/lib/profile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

export default async function AdminPage() {
  if (!await getSession()) return <AuthShell mode="admin"><AuthForm mode="admin" /></AuthShell>;
  const admin = await requireAdmin();
  const defaults = creditSettings();
  const [profileRows] = await db.execute<DatabaseRow[]>('SELECT "avatarId" FROM "userProfile" WHERE "userId" = $1', [admin.id]);
  const [rows] = await db.execute<(DatabaseRow & Omit<DirectoryUser, "createdAt"> & { createdAt: Date })[]>(
    "SELECT u.id, u.name, u.email, u.role, u.\"createdAt\", (COALESCE(w.\"balanceCents\" - w.\"heldCents\",0)::double precision / 100) AS credits, (COALESCE(w.\"multiplierHundred\",$1)::double precision / 100) AS multiplier FROM \"user\" u LEFT JOIN \"creditWallet\" w ON w.\"userId\" = u.id ORDER BY u.\"createdAt\" DESC LIMIT 100", [defaults.defaultMultiplierHundred],
  );
  const [counts] = await db.execute<DatabaseRow[]>(
    "SELECT COUNT(*)::integer AS total, SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END)::integer AS admins, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END)::integer AS members FROM \"user\"",
  );
  const [sessions] = await db.execute<DatabaseRow[]>(
    "SELECT COUNT(*)::integer AS total FROM \"session\" WHERE \"expiresAt\" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
  );
  const users = rows.map(user => ({
    id: user.id, name: user.name, email: user.email, role: user.role,
    createdAt: new Date(user.createdAt).toISOString(), credits: Number(user.credits), multiplier: Number(user.multiplier),
  }));
  const metrics = [
    { label: "Members", value: counts[0].members || 0 },
    { label: "Administrators", value: counts[0].admins || 0 },
    { label: "Active sessions", value: sessions[0].total || 0 },
  ];

  return (
    <AdminWorkspace name={admin.name} avatarId={(profileRows[0]?.avatarId ?? null) as ProfileAvatarId | null}>
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
        <p className="account-note">New account defaults: {(defaults.welcomeCents / 100).toFixed(2)} credits and {(defaults.defaultMultiplierHundred / 100).toFixed(2)}× multiplier. These are a one-time welcome grant; existing accounts keep their balance and rate.</p>
        <UserDirectory users={users} currentUserId={admin.id} />
        <p className="account-note">Member meal and activity records stay out of this view.</p>
      </main>
    </AdminWorkspace>
  );
}
