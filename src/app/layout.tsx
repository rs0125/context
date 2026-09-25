import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wareongo Context",
  description: "Read-only organisational context for your preferred AI tools.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><a className="skip-link" href="#main-content">Skip to main content</a>{children}</body>
    </html>
  );
}
