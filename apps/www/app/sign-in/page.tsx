import type { Metadata } from 'next';
import { PORTALS } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to the Solvenda adviser console, the client portal, or Solvenda Control.',
  robots: { index: false, follow: false },
};

const DESTINATIONS = [
  {
    href: PORTALS.console,
    name: 'Adviser console',
    who: 'Advisers, team leaders, compliance officers and firm administrators',
    detail:
      'Case Intelligence, the case list, tasks, approvals, compliance, quality, analytics and '
      + 'workflow configuration.',
  },
  {
    href: PORTALS.client,
    name: 'Client portal',
    who: 'People whose case a firm is handling',
    detail:
      'Progress, outstanding documents, messages and what happens next — written in plain '
      + 'English and built for a phone.',
  },
  {
    href: PORTALS.control,
    name: 'Solvenda Control',
    who: 'Platform operators',
    detail:
      'Firms, plans, integrations, AI capabilities, support access grants and platform health. '
      + 'Operator accounts hold no permissions inside any firm.',
  },
];

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Sign in</p>
          <h1>Three ways in, depending on who you are</h1>
          <p>
            Each portal is a separate application with its own sign-in, because the people using
            them need different things and should see different things.
          </p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <div className="mk-grid">
            {DESTINATIONS.map((d) => (
              <a key={d.name} href={d.href} className="mk-card mk-card--link">
                <h3>{d.name}</h3>
                <p style={{ color: 'var(--ink)', fontWeight: 500, marginBottom: 'var(--space-2)' }}>
                  {d.who}
                </p>
                <p>{d.detail}</p>
              </a>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
