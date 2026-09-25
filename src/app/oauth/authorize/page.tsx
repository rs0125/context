import type { Metadata } from 'next';
import { AuthorizeApp } from '@/components/oauth/authorize-app';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connect an application | Wareongo Context', robots: { index: false, follow: false } };

export default function AuthorizePage() {
  return <AuthorizeApp />;
}
