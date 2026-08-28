import Link from 'next/link';
import type { OperatorSession } from '@/lib/control/session';

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
    { href: '/control', label: 'Health', key: 'health' },
    { href: '/control/tenants', label: 'Firms', key: 'tenants' },
    { href: '/control/plans', label: 'Plans', key: 'plans' },
    { href: '/control/providers', label: 'Integrations', key: 'providers' },
    { href: '/control/capabilities', label: 'AI capabilities', key: 'capabilities' },
    { href: '/control/enquiries', label: 'Enquiries', key: 'enquiries' },
    { href: '/control/access', label: 'Support access', key: 'access' },
    { href: '/control/activity', label: 'Security activity', key: 'activity' },
  ];

  return (
    <div className="ct-app">
      <nav className="ct-sidebar" aria-label="Main">
        <Link href="/control" className="ct-brand">
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
          <form method="post" action="/control/sign-out" style={{ marginTop: 8 }}>
            <button type="submit" className="sv-btn sv-btn--ghost sv-btn--sm"
                    style={{ padding: 0, color: 'inherit' }}>Sign out</button>
          </form>
        </div>
      </nav>
      <main className="ct-main">{children}</main>
    </div>
  );
}
