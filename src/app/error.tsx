"use client";

import Link from "next/link";
import { Brand } from "@/components/brand";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="error-page"><Brand /><main id="main-content"><h1>Something went wrong</h1><p>We couldn’t load this page. Please try again.</p><button className="primary-button" onClick={reset}>Try again</button><Link href="/login">Back to sign in</Link></main></div>;
}
