import Link from "next/link";
import { MemberTabs } from "@/components/member-tabs";
import { requireUser } from "@/lib/session";
import { AppIcon, type AppTab } from "@/components/app-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your space" };

const features = [
  { id: "food" as const, title: "Food journal", copy: "A place for the meals that make you feel good.", heading: "Your food journal", detail: "Log your meals and nutrition, and look back at your day." },
  { id: "activity" as const, title: "Movement you love", copy: "A walk, a stretch, a little more room to move.", heading: "Your activity", detail: "A place for your walks, workouts, and everyday movement. Exercise logging is coming soon." },
  { id: "progress" as const, title: "Your small beginnings", copy: "See how your everyday efforts add up.", heading: "Your progress", detail: "Your daily goals and monthly milestones will live here. Progress tracking is coming soon." },
];

function SmallSteps() {
  return <svg className="home-illustration" viewBox="0 0 180 180" fill="none" aria-hidden="true">
    <path d="M25 161c43-8 89-8 135 0" stroke="#A8DAB5" strokeWidth="2" strokeLinecap="round" />
    <path d="M43 91c-4-36 20-60 54-58 36 1 55 24 52 59-3 40-23 66-58 65-34-1-46-27-48-66Z" fill="#81C995" />
    <path d="M74 87c2-4 6-4 8 0m28 0c2-4 6-4 8 0m-34 21c7 8 16 8 23 0" stroke="#214E2C" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M94 33c-3-11 1-20 11-24 3 12-1 20-11 24Z" fill="#34A853" />
  </svg>;
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; tab?: string; profile?: string }> }) {
  const user = await requireUser();
  const { notice, tab, profile } = await searchParams;
  const feature = features.find(item => item.id === tab);
  const activeTab: AppTab = tab === "chat" ? "chat" : feature?.id ?? "home";
  const firstName = user.name.trim().split(/\s+/)[0];

  return <MemberTabs
    name={user.name}
    isAdmin={user.role === "admin"}
    initialTab={activeTab}
    initialProfileOpen={profile === "1"}
    notice={notice === "admin-only" ? <div className="notice" role="status">The admin area is only available to administrators. You’re signed in to your member account.</div> : undefined}
    home={<>
        <p className="eyebrow">Your everyday, a little better</p>
        <h1>Hi, {firstName}.</h1>
        <p className="page-subtitle">Let’s make a little room for feeling good.</p>
        <section className="home-welcome" aria-labelledby="welcome-title">
          <div><p className="eyebrow">ONE SMALL STEP AT A TIME</p><h2 id="welcome-title">Small steps.<br />Good days ahead.</h2><p>A meal you enjoyed. A walk outside.<br />It all starts with a little care.</p><Link className="primary-button home-chat-link" href="/app?tab=chat" prefetch={false}>Talk to Kay <span aria-hidden="true">↗</span></Link></div>
          <SmallSteps />
        </section>
        <div className="section-heading"><h2>A space for your healthy habits</h2><p>Make a little time for you</p></div>
        <div className="home-cards">{features.map(item => <Link className="feature-card" key={item.id} href={`/app?tab=${item.id}`} prefetch={false}>
          <AppIcon name={item.id} />
          <h3>{item.title}</h3><p>{item.copy}</p><span className="card-link">{item.id === "food" ? "Log your food" : "Take a look"} <span aria-hidden="true">↗</span></span>
        </Link>)}</div>
        <section className="account-ready">
          <div className="ready-check" aria-hidden="true">✓</div><div><h2>Your account is ready.</h2><p>Signed in as <strong>{user.email}</strong>.</p></div>
        </section>
        {user.role === "admin" && <div className="account-note"><Link href="/admin">Open administration</Link></div>}
    </>}
    activity={<UpcomingFeature id="activity" />}
    progress={<UpcomingFeature id="progress" />}
  />;
}

function UpcomingFeature({ id }: { id: "activity" | "progress" }) {
  const feature = features.find(item => item.id === id)!;
  return <>
    <p className="eyebrow">Your space / {id === "activity" ? "Activity" : "Progress"}</p>
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
