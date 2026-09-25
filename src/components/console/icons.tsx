type IconName = 'arrow' | 'copy' | 'check' | 'key' | 'book' | 'logout' | 'plus' | 'upload' | 'eye' | 'eye-off' | 'refresh' | 'close' | 'search' | 'shield' | 'code' | 'file' | 'chevron' | 'alert' | 'external';

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <><path d="M4 12h15M13 5l7 7-7 7" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    key: <><circle cx="8" cy="9" r="4" /><path d="m11 12 9 9m-5-5 3-3m-6 0 3-3" /></>,
    book: <><path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15" /></>,
    logout: <><path d="M10 4H4v16h6m4-12 4 4-4 4m-5-4h12" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    'eye-off': <><path d="m3 3 18 18M10 5c6-1 12 7 12 7a22 22 0 0 1-4 5M6 6a22 22 0 0 0-4 6s4 7 10 7c1 0 3 0 4-1" /><path d="M10 10a3 3 0 0 0 4 4" /></>,
    refresh: <><path d="M20 7a8 8 0 1 0 0 10M20 3v5h-5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
    file: <><path d="M13 3H5v18h14V9l-6-6Z" /><path d="M13 3v6h6M8 13h8m-8 4h6" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6" /></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
