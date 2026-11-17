"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AppShell, type AppTab } from "./app-header";
import { FoodChat } from "./food-chat";
import { FoodJournal } from "./food-journal";

const readTab = (search: string): AppTab => {
  const value = new URLSearchParams(search).get("tab");
  return value === "chat" || value === "food" || value === "activity" || value === "progress" ? value : "home";
};

export function MemberTabs({ name, isAdmin, initialTab, notice, home, activity, progress }: {
  name: string; isAdmin: boolean; initialTab: AppTab; notice?: ReactNode;
  home: ReactNode; activity: ReactNode; progress: ReactNode;
}) {
  const [tab, setTab] = useState(initialTab);
  const current = useRef(initialTab);
  const scrollPositions = useRef<Partial<Record<AppTab, number>>>({});

  function selectTab(next: AppTab) {
    if (next === current.current) return;
    scrollPositions.current[current.current] = window.scrollY;
    current.current = next;
    setTab(next);
  }

  useEffect(() => {
    function restoreTab() { selectTab(readTab(window.location.search)); }
    restoreTab();
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);

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
    const destination = url.pathname + url.search + url.hash;
    if (destination !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState(null, "", destination);
    }
    selectTab(readTab(url.search));
  }

  return <div onClickCapture={navigate}>
    <AppShell name={name} isAdmin={isAdmin} activeTab={tab}>
      <main id="main-content" className={tab === "chat" ? "workspace-main member-main ai-main" : "workspace-main member-main"}>
        {notice}
        <div hidden={tab !== "home"}>{home}</div>
        <div hidden={tab !== "chat"}><FoodChat active={tab === "chat"} /></div>
        <div hidden={tab !== "food"}><FoodJournal active={tab === "food"} /></div>
        <div hidden={tab !== "activity"}>{activity}</div>
        <div hidden={tab !== "progress"}>{progress}</div>
      </main>
    </AppShell>
  </div>;
}
