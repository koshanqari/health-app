import Link from "next/link";
import { Brand } from "./brand";

type AuthMode = "login" | "signup" | "admin";

function ASmallBeginning() {
  return <svg className="auth-illustration" viewBox="0 0 420 260" fill="none" aria-hidden="true">
    <path d="M48 239c80-11 191-12 324 0" stroke="#D2E7D7" strokeWidth="2" strokeLinecap="round" />
    <path d="M99 132c-4-54 27-92 81-94 58-2 104 31 104 89 0 61-35 105-94 106-60 1-88-41-91-101Z" fill="#81C995" />
    <path d="M153 121c3-5 8-5 11 0m48 0c3-5 8-5 11 0" stroke="#214E2C" strokeWidth="4" strokeLinecap="round" />
    <path d="M171 148c10 12 25 12 35 0" stroke="#214E2C" strokeWidth="4" strokeLinecap="round" />
    <path d="M189 37c-4-17 1-28 14-34 4 17-1 28-14 34Z" fill="#34A853" />
    <path d="M310 237v-64m0 35c-22 0-34-12-34-28 21 0 34 12 34 28Zm0-13c21 0 31-12 31-27-20 1-31 12-31 27Z" stroke="#81C995" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

export function AuthShell({ mode, children }: { mode: AuthMode; children: React.ReactNode }) {
  const isAdmin = mode === "admin";
  const isSignup = mode === "signup";
  return <div className="auth-page">
    <header className="auth-header"><Brand /><Link href={isAdmin || isSignup ? "/login" : "/signup"}>{isAdmin ? "Member sign in" : isSignup ? "Already a member? Sign in" : "Create an account"}</Link></header>
    <main id="main-content" className="auth-layout">
      <section className="auth-story">
        <p className="eyebrow">A little care, every day</p>
        <h2>{isAdmin ? <>Good things grow<br />with a little care.</> : <>Feel good.<br />At your own pace.</>}</h2>
        <p>{isAdmin ? "A welcoming space starts with the people who look after it." : "A meal you enjoyed. A walk outside. Small steps toward a healthier you."}</p>
        <ASmallBeginning />
      </section>
      <section className="auth-panel">
        <h1>{isAdmin ? "Admin sign in" : isSignup ? "Let’s begin." : "Welcome back."}</h1>
        <p className="auth-description">{isAdmin ? "Look after your Daywell community." : isSignup ? "Your next small step starts here." : "A little time for yourself. Glad you’re here."}</p>
        {children}
      </section>
    </main>
    <footer className="auth-footer"><span>A little kinder to yourself, every day.</span>{isAdmin && <Link href="/login">Back to member sign in</Link>}</footer>
  </div>;
}
