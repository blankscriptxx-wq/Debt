import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Control', template: '%s — Solvenda Control' },
  description: 'Platform administration.',
  robots: { index: false, follow: false },
};

export default function ControlLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
