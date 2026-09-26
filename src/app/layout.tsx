import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  variable: "--font-context",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Wareongo Context",
  description: "Read-only organisational context for your preferred AI tools.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body><a className="skip-link" href="#main-content">Skip to main content</a>{children}</body>
    </html>
  );
}
