import type { Metadata } from 'next';
import './globals.css';
import './console.css';
import './portal.css';
import './control.css';

/**
 * The single root layout.
 *
 * Four surfaces live in one application — the marketing site at the root, the
 * adviser console at /app, the client portal at /portal and Solvenda Control at
 * /control — so there is one deployment, one domain and one build rather than
 * four projects that have to be kept in step.
 *
 * All four stylesheets are imported here. They do not collide: the marketing
 * site uses `mk-`, the console `sv-`, the client portal `cp-` and Control `ct-`,
 * over the shared tokens in @solvenda/ui. Loading them together is also what
 * fixed Control's sign-in page, which used `sv-login` classes that only ever
 * existed in the console's stylesheet and so rendered unstyled.
 *
 * Each area supplies its own nested layout for chrome and metadata.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://solvenda.example'),
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
      <body>{children}</body>
    </html>
  );
}
