import type { Metadata } from 'next';
import { PLANS, poundsFromPence as gbp } from '@solvenda/db/plans';
import { HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Solvenda pricing: a platform fee, seats, and usage metered where our own cost is variable. Published figures, stated openly.',
};

const FEATURE_LABELS: Record<string, string> = {
  'case-management': 'Case management, every stage',
  'client-portal': 'Client portal (PWA)',
  workflows: 'No-code workflow engine',
  'standard-reporting': 'Standard reporting',
  'ai-intelligence': 'Case Intelligence and the AI capability set',
  'ai-qa': 'AI-assisted quality assurance',
  'compliance-monitoring': 'Compliance monitoring and file review',
  'creditor-portal': 'Creditor portal',
  'introducer-portal': 'Introducer portal',
  'public-api': 'Public API and webhooks',
  'advanced-reporting': 'Advanced and configurable reporting',
  sso: 'SAML / OIDC single sign-on',
  'custom-retention': 'Custom retention and legal hold policy',
  'sandbox-environment': 'Sandbox tenant',
  'migration-service': 'Managed migration',
};

const SUPPORT_LABELS: Record<string, string> = {
  standard: 'Standard support',
  priority: 'Priority support',
  enterprise: 'Enterprise support, named contact',
};

/**
 * The usage lines, restated from each plan's `usageTerms`.
 *
 * Metering exists on four things and only four things, because those are the
 * four places where serving one more case genuinely costs us more: model
 * tokens, Open Banking calls, outbound messages and stored documents. We do
 * not meter cases, clients or logins — charging per case gives a firm a
 * reason to keep a file out of the system, which is the opposite of what a
 * compliance record is for.
 */
function usageRows() {
  return PLANS.map((plan) => {
    const t = plan.usageTerms as Record<string, Record<string, number | string>>;
    const ai = t['ai.tokens']!;
    const ob = t['open-banking.calls']!;
    const comms = t['comms.messages']!;
    const storage = t['storage.gb']!;
    return {
      name: plan.name,
      ai:
        typeof ai['includedPencePerMonth'] === 'number'
          ? `${gbp(ai['includedPencePerMonth'])}/mo included, then cost × ${String(ai['overageMultiplier'])}`
          : String(ai['note'] ?? '—'),
      openBanking: `${Number(ob['includedPerMonth']).toLocaleString('en-GB')}/mo, then ${String(ob['overagePence'])}p`,
      comms: `${Number(comms['includedPerMonth']).toLocaleString('en-GB')}/mo, then ${String(comms['overagePence'])}p`,
      storage: `${Number(storage['includedGb']).toLocaleString('en-GB')} GB, then ${String(storage['overagePencePerGb'])}p/GB`,
    };
  });
}

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Pricing</p>
          <h1>Priced as the system a firm runs on</h1>
          <p>
            A platform fee for the system itself, seats for the people using it, and metering on
            the four things that genuinely cost us more when a firm does more. Published, because
            a price you have to ask for is a price that varies by how well you negotiate.
          </p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <div className="mk-plans">
            {PLANS.map((plan) => (
              <div
                key={plan.key}
                className={`mk-plan${plan.key === 'firm' ? ' mk-plan--featured' : ''}`}
              >
                <h3>{plan.name}</h3>
                <p className="mk-plan__desc">{plan.description}</p>
                <p className="mk-plan__price">{gbp(plan.platformFeePence)}</p>
                <p className="mk-plan__unit">
                  per month, plus {gbp(plan.perSeatPence)} per seat beyond {plan.includedSeats}{' '}
                  included
                </p>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}>{FEATURE_LABELS[f] ?? f}</li>
                  ))}
                </ul>
                <p className="mk-plan__terms">
                  {plan.minimumTermMonths}-month minimum term ·{' '}
                  {SUPPORT_LABELS[plan.supportTier] ?? plan.supportTier}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>What is metered</h2>
          <p className="mk-section__lede">
            Four lines, because there are four places where one more case costs us more. Cases,
            clients and logins are not metered: charging per case gives a firm a reason to keep a
            file out of the system, which is the opposite of what a compliance record is for.
          </p>
          <div className="mk-scroll">
            <table className="mk-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>AI</th>
                  <th>Open Banking calls</th>
                  <th>Messages</th>
                  <th>Document storage</th>
                </tr>
              </thead>
              <tbody>
                {usageRows().map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.ai}</td>
                    <td>{row.openBanking}</td>
                    <td>{row.comms}</td>
                    <td>{row.storage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>What is not charged separately</h2>
          <p style={{ color: 'var(--ink-muted)' }}>
            Adding a case type, changing a workflow, adding a custom field, adding a document
            template, changing a permission or turning an AI capability on and off are all
            configuration a firm's own administrator does. Incumbent platforms in this market bill
            those as change requests, which is why a firm's process ends up shaped by what it can
            afford to ask for. We would rather charge more for the platform and nothing for
            changing your mind.
          </p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Implementation and migration</h2>
          <p style={{ color: 'var(--ink-muted)' }}>
            Quoted per engagement against the actual source system, because the honest range is
            wide: a migration from a well-kept incumbent database and a migration from fifteen
            years of spreadsheets and a shared drive are not the same job. The framework itself —
            source profiles, field mapping, validation, dry run, reconciliation, rollback and a
            signed migration report — is part of the platform on every plan, and Enterprise
            includes us running it.
          </p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection
            title="What these figures are, and are not"
            items={[
              'A reasoned opening position, not observed contract values. The established vendors in this market are private and do not publish, so nobody outside them has a verified benchmark — including us.',
              'Set against what the platform replaces (a case management system, a QA sampling process, a reporting stack and a quantity of manual file review), not against a per-seat SaaS comparison.',
              'Not yet validated against a signed contract. Solvenda has no customers, and this page does not imply otherwise.',
              'Exclusive of VAT. Third-party costs a firm holds directly — Open Banking provider fees, credit reference agency charges, telephony minutes — are the firm’s own contracts and are not resold through us.',
            ]}
          />
        </div>
      </section>
    </>
  );
}
