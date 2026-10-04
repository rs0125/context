import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" },
    ] }, {
      // Native form POSTs need the browser's same-origin Origin header for CSRF
      // verification. no-referrer serializes that Origin as null. Keep external
      // referrers suppressed and permit only Google's fixed OAuth destination.
      source: '/mail', headers: [
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com" },
      ],
    }];
  },
};
export default config;
