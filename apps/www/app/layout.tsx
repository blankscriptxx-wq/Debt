import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/layout';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://solvenda.example'),
  title: {
    default: 'Solvenda — the operating system for regulated financial-difficulty services',
    template: '%s — Solvenda',
  },
  description:
    'Case management and case intelligence for UK firms giving debt advice, running debt ' +
    'management plans and administering personal insolvency.',
  openGraph: { type: 'website', locale: 'en_GB', siteName: 'Solvenda' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
