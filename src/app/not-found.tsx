import Link from "next/link";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return <div className="error-page"><Brand /><main id="main-content"><p className="eyebrow">404 · Page not found</p><h1>Page not found</h1><p>The page you’re looking for doesn’t exist.</p><Link className="primary-button" href="/login">Back to sign in</Link></main></div>;
}
