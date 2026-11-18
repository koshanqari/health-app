"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "./app-header";
import { Profile } from "./profile";
import type { ProfileAvatarId } from "@/lib/profile";

export function AdminWorkspace({ name, avatarId, children, docs }: { name: string; avatarId: ProfileAvatarId | null; children: ReactNode; docs: ReactNode }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [picture, setPicture] = useState(avatarId);
  const router = useRouter();
  const active = useSearchParams().get("tab") === "docs" ? "docs" : "community";
  useEffect(() => { setDisplayName(name); setPicture(avatarId); }, [name, avatarId]);
  return <>
    <AppShell name={displayName} avatarId={picture} isAdmin area="admin" onOpenProfile={() => setProfileOpen(true)}>
      <div className="admin-layout">
        <nav className="admin-sidebar" aria-label="Administration">
          <p>Administration</p>
          {[{ id: "community", label: "Community", href: "/admin" }, { id: "docs", label: "Docs", href: "/admin?tab=docs" }].map(tab => <Link key={tab.id} href={tab.href} prefetch={false} aria-current={active === tab.id ? "page" : undefined} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); if (active !== tab.id) window.history.pushState(null, "", tab.href);
          }}>{tab.label}</Link>)}
        </nav>
        <main id="main-content" className="workspace-main admin-main">
          <div hidden={active !== "community"}>{children}</div>
          <div hidden={active !== "docs"}>{docs}</div>
        </main>
      </div>
    </AppShell>
    {profileOpen && <Profile admin onClose={() => setProfileOpen(false)} onSaved={user => { setDisplayName(user.name); setPicture(user.avatarId); router.refresh(); }} />}
  </>;
}
