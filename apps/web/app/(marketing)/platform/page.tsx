import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/marketing/layout';

export const metadata: Metadata = {
  title: 'Platform',
  description: 'Case management for UK debt advice, debt management and personal insolvency: lead to closure, across every solution.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Platform</p>
          <h1>Lead to closure, across every solution</h1>
          <p>One journey, configured per case type: referral, onboarding, consent, identity, vulnerability, Open Banking, credit information, income and expenditure, debts, affordability, eligibility, solution comparison, advice, documents, signature, implementation, payments, ongoing management, review, arrears, closure.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Case types are data</h2>
          <p style={{ color: 'var(--ink-muted)' }}>A case type carries its own stages, required evidence, eligibility rules, compliance rules and review cadence. DMP, IVA, DRO, bankruptcy, Breathing Space, Protected Trust Deed, sequestration and the Debt Arrangement Scheme all ship this way, and a firm can add its own. Adding one requires no release from us, and a test in our suite defines an entirely new solution and drives it through the same engine to prove it.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Statutory limits are values, not constants</h2>
          <p style={{ color: 'var(--ink-muted)' }}>DRO debt, asset and surplus ceilings, Scottish MAP bands, minimum trust deed debt — all referenced as configuration. When a regulation moves you change a number, and the platform records which version was in force when a case was assessed, which is the property that matters at a file review two years later.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>The Standard Financial Statement, properly</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Statements are immutable snapshots. Correcting a figure supersedes the statement rather than editing it, so "what did this file look like when that advice was given" always has an answer. Category totals are compared against the trigger figures in force, and an exceedance asks for an explanation rather than blocking.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Advice is a record, not a field</h2>
          <p style={{ color: 'var(--ink-muted)' }}>A decision cannot be recorded without a current financial statement, an eligibility evaluation, the options considered and a stated reason for rejecting each alternative. It names the person, the competency they held at the time, and the evidence it rested on. A database trigger refuses any later edit to its substance: superseding creates a second record and the original wording survives verbatim.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='What is thinner than the rest' items={['Cashiering and client money are not built.', 'Creditor and introducer portals exist as permission sets and data model, not yet as finished interfaces.', 'The QA reviewer workflow — sampling rules, review queue, sign-off, calibration — is specified and partly built; the capability and its prompt exist and are tested.']} />
        </div>
      </section>
    </>
  );
}
