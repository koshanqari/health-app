import Link from "next/link";
import { Brand } from "./brand";
import { ProfileAvatar } from "./profile-avatar";
import type { ProfileAvatarId } from "@/lib/profile";

export type AppTab = "home" | "chat" | "food" | "activity" | "progress";

const tabs: { id: AppTab; label: string; href: string }[] = [
  { id: "home", label: "Home", href: "/app" },
  { id: "food", label: "Food", href: "/app?tab=food" },
  { id: "chat", label: "AI", href: "/app?tab=chat" },
  { id: "activity", label: "Activity", href: "/app?tab=activity" },
  { id: "progress", label: "Progress", href: "/app?tab=progress" },
];

export function AppIcon({ name }: { name: AppTab }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "home" ? <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>
      : name === "chat" ? <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2v-9.5a9.5 9.5 0 0 1 19-1Z" /><path d="M7 10h9M7 14h6" /></>
      : name === "food" ? <><path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-4 0-5 4-5 8h5" /></>
      : name === "activity" ? <><path d="M4 16c-2-3-2-7 0-10 1-2 4-2 5 0 2 3 1 6 0 9Zm0 2h5v2a2.5 2.5 0 0 1-5 0ZM15 12c-1-3-1-6 1-8 2-2 4-1 5 1 1 3 0 6-1 8Zm0 3 5 1-.5 3a2.5 2.5 0 0 1-5-1Z" /></>
      : <><path d="M4 4v16h17M8 14l4-4 4 3 5-6" /></>}
  </svg>;
}

export function AppShell({ name, avatarId = null, isAdmin = false, area = "member", activeTab = "home", children, onOpenProfile }: {
  name: string; avatarId?: ProfileAvatarId | null; isAdmin?: boolean; area?: "member" | "admin"; activeTab?: AppTab; children: React.ReactNode; onOpenProfile?: () => void;
}) {
  return <div className={area === "member" ? activeTab === "chat" ? "workspace has-bottom-nav ai-workspace" : "workspace has-bottom-nav" : "workspace"}>
    <header className="app-header">
      <div className="app-brand"><Brand href={area === "member" ? "/app" : "/admin"} />{isAdmin && <nav aria-label="Account areas">
        <Link href="/app" prefetch={false} className={area === "member" ? "nav-item active" : "nav-item"} aria-current={area === "member" ? "page" : undefined}>Your space</Link>
        <Link href="/admin" className={area === "admin" ? "nav-item active" : "nav-item"} aria-current={area === "admin" ? "page" : undefined}>Community</Link>
      </nav>}</div>
      <div className="account-actions">{onOpenProfile ? <button type="button" className="avatar" aria-label="Open profile" title={`Profile · ${name}`} onClick={onOpenProfile}><ProfileAvatar avatarId={avatarId} name={name} /></button> : <Link className="avatar" aria-label="Open profile" href={area === "admin" ? "/app?profile=1&returnTo=admin" : "/app?profile=1"} prefetch={false}><ProfileAvatar avatarId={avatarId} name={name} /></Link>}</div>
    </header>
    {children}
    {!(area === "member" && activeTab === "chat") && <footer className="workspace-footer">Small steps. Your own pace.</footer>}
    {area === "member" && <nav className="bottom-nav" aria-label="Main navigation">{tabs.map(tab => <Link key={tab.id} href={tab.href} prefetch={false} className={activeTab === tab.id ? "bottom-nav-item active" : "bottom-nav-item"} aria-current={activeTab === tab.id ? "page" : undefined}><AppIcon name={tab.id} /><span>{tab.label}</span></Link>)}</nav>}
  </div>;
}
