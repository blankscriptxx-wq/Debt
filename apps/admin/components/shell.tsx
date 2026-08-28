import Link from 'next/link';
import type { OperatorSession } from '@/lib/session';

/**
 * The operator shell.
 *
 * The standing reminder about tenant data is not decoration. An operator can
 * see across firms here, and the interface should keep saying so.
 */
export function ControlShell({
  session, current, children,
}: { session: OperatorSession; current: string; children: React.ReactNode }) {
  const links = [
    { href: '/', label: 'Health', key: 'health' },
    { href: '/tenants', label: 'Firms', key: 'tenants' },
    { href: '/plans', label: 'Plans', key: 'plans' },
    { href: '/providers', label: 'Integrations', key: 'providers' },
    { href: '/capabilities', label: 'AI capabilities', key: 'capabilities' },
    { href: '/access', label: 'Support access', key: 'access' },
    { href: '/activity', label: 'Security activity', key: 'activity' },
  ];

  return (
    <div className="ct-app">
      <nav className="ct-sidebar" aria-label="Main">
        <Link href="/" className="ct-brand">
          Solvenda <span className="ct-brand__badge">Control</span>
        </Link>
        <div className="ct-nav">
          {links.map((link) => (
            <Link key={link.key} href={link.href}
                  aria-current={current === link.key ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}
        </div>
        <div style={{ marginTop: 'auto', fontSize: 'var(--text-xs)', color: 'var(--ink-subtle)' }}>
          {session.fullName}
          <br />
          {session.role}
          <br />
          <form method="post" action="/sign-out" style={{ marginTop: 8 }}>
            <button type="submit" className="sv-btn sv-btn--ghost sv-btn--sm"
                    style={{ padding: 0, color: 'inherit' }}>Sign out</button>
          </form>
        </div>
      </nav>
      <main className="ct-main">{children}</main>
    </div>
  );
}
