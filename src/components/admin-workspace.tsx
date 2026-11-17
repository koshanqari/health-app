"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "./app-header";
import { Profile } from "./profile";
import type { ProfileAvatarId } from "@/lib/profile";

export function AdminWorkspace({ name, avatarId, children }: { name: string; avatarId: ProfileAvatarId | null; children: ReactNode }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [picture, setPicture] = useState(avatarId);
  const router = useRouter();
  useEffect(() => { setDisplayName(name); setPicture(avatarId); }, [name, avatarId]);
  return <>
    <AppShell name={displayName} avatarId={picture} isAdmin area="admin" onOpenProfile={() => setProfileOpen(true)}>{children}</AppShell>
    {profileOpen && <Profile admin onClose={() => setProfileOpen(false)} onSaved={user => { setDisplayName(user.name); setPicture(user.avatarId); router.refresh(); }} />}
  </>;
}
