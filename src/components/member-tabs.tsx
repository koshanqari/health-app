"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { MemberViewProvider, ViewingBanner, type ViewingAs } from "./member-view";
import { AppShell, type AppTab } from "./app-header";
import { FoodChat } from "./food-chat";
import { FoodJournal } from "./food-journal";
import { Profile } from "./profile";
import { useRouter } from "next/navigation";
import type { ProfileAvatarId } from "@/lib/profile";

const readTab = (search: string): AppTab => {
  const value = new URLSearchParams(search).get("tab");
  return value === "chat" || value === "food" || value === "activity" || value === "progress" ? value : "home";
};

export function MemberTabs({ name, initialAvatarId = null, isAdmin, initialTab, initialProfileOpen = false, notice, home, activity, progress, viewingAs = null }: {
  name: string; initialAvatarId?: ProfileAvatarId | null; isAdmin: boolean; initialTab: AppTab; initialProfileOpen?: boolean; notice?: ReactNode;
  viewingAs?: ViewingAs | null;
  home: ReactNode; activity: ReactNode; progress: ReactNode;
}) {
  const [aiStarter, setAiStarter] = useState<{ id: number; prompt: string } | null>(null);
  const [tab, setTab] = useState(initialTab);
  const [profileOpen, setProfileOpen] = useState(initialProfileOpen);
  const [displayName, setDisplayName] = useState(name);
  const [avatarId, setAvatarId] = useState(initialAvatarId);
  const router = useRouter();
  const current = useRef(initialTab);
  const scrollPositions = useRef<Partial<Record<AppTab, number>>>({});

  function selectTab(next: AppTab) {
    if (next === current.current) return;
    scrollPositions.current[current.current] = window.scrollY;
    current.current = next;
    setTab(next);
  }

  useEffect(() => {
    function restoreTab() { selectTab(readTab(window.location.search)); setProfileOpen(new URLSearchParams(window.location.search).get("profile") === "1"); }
    restoreTab();
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  useEffect(() => { setDisplayName(name); }, [name]);
  useEffect(() => { setAvatarId(initialAvatarId); }, [initialAvatarId]);

  function askAIForGoals(effectiveFrom: string) {
    setAiStarter({ id: Date.now(), prompt: "Help me set daily calorie, protein, carbs and fat goals, applying from " + effectiveFrom + ". Use my saved profile, ask for any missing details, then prepare a goal proposal I can review and save." });
    window.history.pushState(null, "", "/app?tab=chat");
    selectTab("chat");
  }

  function openProfile() {
    const url = new URL(window.location.href);
    url.searchParams.set("profile", "1");
    window.history.pushState({ daywellProfile: true }, "", url.pathname + url.search);
    setProfileOpen(true);
  }

  function closeProfile() {
    setProfileOpen(false);
    const url = new URL(window.location.href);
    if (isAdmin && url.searchParams.get("returnTo") === "admin") { router.replace("/admin"); return; }
    if (window.history.state?.daywellProfile) { window.history.back(); return; }
    url.searchParams.delete("profile"); url.searchParams.delete("returnTo");
    window.history.replaceState(null, "", url.pathname + url.search);
  }

  useLayoutEffect(() => {
    window.scrollTo({ top: scrollPositions.current[tab] ?? 0, behavior: "instant" });
  }, [tab]);

  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== "/app") return;
    event.preventDefault();
    if (viewingAs) url.searchParams.set("view", viewingAs.token);
    const destination = url.pathname + url.search + url.hash;
    if (destination !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState(null, "", destination);
    }
    selectTab(readTab(url.search));
  }

  return <MemberViewProvider value={viewingAs}><div onClickCapture={navigate}>
    <AppShell name={displayName} avatarId={avatarId} isAdmin={isAdmin} activeTab={tab} onOpenProfile={openProfile}>
      <ViewingBanner />
      <main id="main-content" className={tab === "chat" ? "workspace-main member-main ai-main" : "workspace-main member-main"}>
        {notice}
        <div hidden={tab !== "home"}>{home}</div>
        <div hidden={tab !== "chat"}><FoodChat active={tab === "chat"} starter={aiStarter} /></div>
        <div hidden={tab !== "food"}><FoodJournal active={tab === "food"} onAskAI={viewingAs ? undefined : askAIForGoals} /></div>
        <div hidden={tab !== "activity"}>{activity}</div>
        <div hidden={tab !== "progress"}>{progress}</div>
      </main>
    </AppShell>
    {profileOpen && <Profile onClose={closeProfile} onSaved={user => { setDisplayName(user.name); setAvatarId(user.avatarId); router.refresh(); }} />}
  </div></MemberViewProvider>;
}
