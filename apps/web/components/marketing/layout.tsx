import Link from 'next/link';

/**
 * The portals, now routes in this application rather than separate deployments.
 *
 * One project, one domain, one build: the marketing site at the root, the
 * adviser console at /app, the client portal at /portal and Solvenda Control at
 * /control. Keeping them as four Vercel projects meant three of them were never
 * deployed at all, which is a failure mode a monorepo makes easy and quiet.
 */
export const PORTALS = {
  console: '/app',
  client: '/portal',
  control: '/control',
};

const NAV = [
  { href: '/platform', label: 'Platform' },
  { href: '/intelligence', label: 'Intelligence' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/security', label: 'Security' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/pricing', label: 'Pricing' },
];

export function SiteHeader() {
  return (
    <header className="mk-header">
      <div className="mk-container mk-header__inner">
        <Link href="/" className="mk-logo">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <path d="M2 16c4.5 0 4.5-10 9-10s4.5 10 9 10" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          Solvenda
        </Link>
        <nav className="mk-nav" aria-label="Main">
          {NAV.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className="mk-header__actions">
          <Link href="/sign-in" className="mk-btn mk-btn--secondary"
                style={{ padding: 'var(--space-2) var(--space-4)', minHeight: 40 }}>
            Sign in
          </Link>
          <Link href="/contact" className="mk-btn mk-btn--primary"
                style={{ padding: 'var(--space-2) var(--space-4)', minHeight: 40 }}>
            Talk to us
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mk-footer">
      <div className="mk-container">
        <div className="mk-footer__grid">
          <div>
            <h4>Platform</h4>
            <Link href="/platform">Case management</Link>
            <Link href="/intelligence">Case Intelligence</Link>
            <Link href="/compliance">Compliance and QA</Link>
            <Link href="/migration">Migration</Link>
          </div>
          <div>
            <h4>Technical</h4>
            <Link href="/security">Security</Link>
            <Link href="/integrations">Integrations</Link>
            <Link href="/developers">Developer platform</Link>
          </div>
          <div>
            <h4>Commercial</h4>
            <Link href="/pricing">Pricing</Link>
            <Link href="/contact">Talk to us</Link>
          </div>
          <div>
            <h4>Sign in</h4>
            <Link href={PORTALS.console}>Adviser console</Link>
            <Link href={PORTALS.client}>Client portal</Link>
            <Link href={PORTALS.control}>Solvenda Control</Link>
          </div>
        </div>
        <p style={{ marginTop: 'var(--space-6)', marginBottom: 0 }}>
          Solvenda is software for firms operating in the UK debt advice, debt management and
          personal insolvency market. Solvenda is not authorised or regulated by the Financial
          Conduct Authority and does not give debt advice. Firms using the platform remain
          responsible for their own regulatory obligations.
        </p>
      </div>
    </footer>
  );
}

/**
 * A claim and the mechanism behind it, side by side.
 *
 * Used everywhere on this site instead of adjectives. The audience has read a
 * great deal of vendor copy and believes none of it; the only thing that lands
 * is a specific, checkable statement about how something works.
 */
export function Claim({ what, how }: { what: string; how: string }) {
  return (
    <div className="mk-claim">
      <p className="mk-claim__what">{what}</p>
      <p className="mk-claim__how">{how}</p>
    </div>
  );
}

/**
 * What is not built yet, stated on the page rather than discovered in
 * procurement. A firm that finds out during due diligence that a claim was
 * thin does not come back.
 */
export function HonestSection({
  title, items,
}: { title: string; items: string[] }) {
  return (
    <div className="mk-honest">
      <h3>{title}</h3>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}
