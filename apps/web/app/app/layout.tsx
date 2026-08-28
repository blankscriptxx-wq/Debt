import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Console', template: '%s — Solvenda Console' },
  description: 'Case management and intelligence for regulated financial-difficulty services.',
  robots: { index: false, follow: false },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
