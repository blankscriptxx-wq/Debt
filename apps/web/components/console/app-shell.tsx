import Link from 'next/link';
import { CommandPalette } from './command-palette';

export interface NavCounts {
  cases: number;
  tasks: number;
  approvals: number;
}

/**
 * The console shell.
 *
 * Navigation is grouped by what an adviser is doing rather than by which module
 * a feature lives in, because "where do I find X" is answered by the job, not
 * by the architecture.
 */
export function AppShell({
  firmName, userName, counts, current, children,
}: {
  firmName: string; userName: string; counts: NavCounts;
  current: string; children: React.ReactNode;
}) {
  const items = [
    { group: 'Work', links: [
      { href: '/app', label: 'Overview', key: 'overview' },
      { href: '/app/cases', label: 'Cases', key: 'cases', count: counts.cases },
      { href: '/app/tasks', label: 'Tasks', key: 'tasks', count: counts.tasks },
      { href: '/app/approvals', label: 'Approvals', key: 'approvals', count: counts.approvals },
    ]},
    { group: 'Oversight', links: [
      { href: '/app/compliance', label: 'Compliance', key: 'compliance' },
      { href: '/app/quality', label: 'Quality assurance', key: 'quality' },
      { href: '/app/analytics', label: 'Analytics', key: 'analytics' },
    ]},
    { group: 'Configuration', links: [
      { href: '/app/workflows', label: 'Workflows', key: 'workflows' },
      { href: '/app/settings', label: 'Settings', key: 'settings' },
    ]},
  ];

  return (
    <div className="sv-app">
      <nav className="sv-sidebar" aria-label="Main">
        <div>
          <Link href="/app" className="sv-brand">
            <span className="sv-brand__mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M2 13c3.5 0 3.5-8 7-8s3.5 8 7 8" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            Solvenda
          </Link>
          <p className="sv-firm">{firmName}</p>
        </div>

        <div className="sv-nav">
          {items.map((section) => (
            <div key={section.group}>
              <p className="sv-nav__group">{section.group}</p>
              {section.links.map((link) => (
                <Link key={link.key} href={link.href} className="sv-nav__item"
                      aria-current={current === link.key ? 'page' : undefined}>
                  {link.label}
                  {'count' in link && link.count ? (
                    <span className="sv-nav__count">{link.count}</span>
                  ) : null}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 'auto', fontSize: 'var(--text-xs)', color: 'var(--ink-subtle)' }}>
          {userName}
          <br />
          {/* A form, not a link: Next prefetches links, and a prefetched
              sign-out would end the session on page render. */}
          <form method="post" action="/app/logout">
            <button type="submit" className="sv-btn sv-btn--ghost sv-btn--sm"
                    style={{ padding: 0, color: 'inherit', fontSize: 'inherit' }}>
              Sign out
            </button>
          </form>
        </div>
      </nav>

      <div className="sv-main">
        <header className="sv-topbar">
          <CommandPalette />
        </header>
        <main className="sv-content">{children}</main>
      </div>
    </div>
  );
}
