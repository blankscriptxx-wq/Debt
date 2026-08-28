import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Your case', template: '%s — Solvenda' },
  description: 'Your debt solution: progress, documents and messages.',
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
