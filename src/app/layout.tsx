import type { Metadata } from "next";
import "@fontsource-variable/nunito-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Daywell — A healthier everyday", template: "%s · Daywell" },
  description: "A personal space for eating well, moving more, and building healthier everyday habits.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to content</a>{children}</body></html>;
}
