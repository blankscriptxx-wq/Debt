import Link from 'next/link';
import { Claim, HonestSection } from '@/components/layout';

export default function HomePage() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">For UK debt advice, DMP and insolvency firms</p>
          <h1>The compliance evidence should be a by-product of the work.</h1>
          <p>
            Solvenda is case management for firms giving debt advice, running debt management
            plans and administering personal insolvency — built so that understanding a case
            and evidencing a decision are things the software does, not tasks someone has to
            remember.
          </p>
          <div className="mk-actions">
            <Link href="/contact" className="mk-btn mk-btn--primary">Talk to us</Link>
            <Link href="/platform" className="mk-btn mk-btn--secondary">See how it works</Link>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>The problem is not that your system stores information</h2>
          <p className="mk-section__lede">
            It is that nothing in it understands the case. An adviser opens a file and spends
            the first several minutes reconstructing it from a dozen screens. The surplus that
            quietly halved, the review three weeks overdue, the vulnerability a colleague
            recorded last month — those are exactly the things easiest to miss, and exactly the
            things a complaint turns on.
          </p>

          <div className="mk-grid">
            <div className="mk-card">
              <h3>Case Intelligence</h3>
              <p>
                Health with the signals that produced it, what is blocking advice, what to do
                next and why, and what has changed since the last review. Every element names
                the records behind it, so nothing has to be taken on trust.
              </p>
            </div>
            <div className="mk-card">
              <h3>AI that assists, never decides</h3>
              <p>
                Analysis, drafting, discrepancy detection and QA — with a hard structural limit:
                no automated principal can record a regulated decision. Not a policy. A branch
                in the authorisation engine, tested against every regulated permission.
              </p>
            </div>
            <div className="mk-card">
              <h3>Configuration, not change requests</h3>
              <p>
                Case types, forms, fields, workflows and eligibility rules are data your
                administrators edit. Adding a solution requires no release from us. When a
                statutory limit moves, you change a value.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>Claims, with the mechanism attached</h2>
          <p className="mk-section__lede">
            You have read a lot of vendor copy. Here is how each of these actually works, so you
            can check them.
          </p>

          <Claim
            what="One firm cannot see another firm's clients."
            how="Enforced by Postgres row-level security under a database role that cannot bypass it, with the tenant bound per transaction. A query written without a tenant filter returns nothing rather than someone else's data — and the schema owner is subject to the same policies. Proven by a test suite that attempts cross-tenant reads, joins, aggregates, forged inserts and updates."
          />
          <Claim
            what="Nobody can quietly edit history."
            how="The audit ledger is append-only by database trigger and revoked grants, and every entry is SHA-256 chained to its predecessor per firm. Altering a record breaks the chain, and verification reports exactly where. A regulated action without a stated reason is refused outright."
          />
          <Claim
            what="AI cannot issue advice."
            how="Suggestions that would change anything become proposals. A proposal touching regulated information can only be resolved by a person holding the relevant competency, with a completed second factor. An API key holding every scope in the catalogue and a workflow explicitly configured with the permission are both refused."
          />
          <Claim
            what="Declared and observed expenditure are compared, and neither overwrites the other."
            how="Bank data is categorised and compared against the Standard Financial Statement, and material differences are raised as questions for the adviser to put to the client — with the wording written for them to use. Irregular income, cash spending and a second account all look identical in the data, so the platform asks rather than concludes."
          />
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>What we have not built</h2>
          <p className="mk-section__lede">
            You will find this out in procurement anyway. Better here.
          </p>
          <HonestSection
            title="Honest position, today"
            items={[
              'Integrations are sandbox simulators. No live vendor credentials exist, and every simulated call is labelled as such in the product. Connecting a real Open Banking, CRA, KYC, e-signature or payments provider is implementation work, not a switch.',
              'Client money and cashiering are not built. If your firm handles client funds, that stays where it is for now and we integrate.',
              'We hold no certifications. No ISO 27001, no SOC 2, no penetration test has been carried out. We are not FCA authorised and do not need to be — but we will not pretend otherwise.',
              'We have no customers yet. Solvenda is a new platform and this is the first version.',
              'Standard Financial Statement spending guidelines are licensed content you supply under your own membership. We ship the structure and the versioning, not the figures.',
            ]}
          />
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container">
          <h2>Built for the whole journey</h2>
          <div className="mk-grid">
            {[
              ['Debt Management Plans', 'Informal arrangements with review cadence, arrears handling and creditor servicing.'],
              ['Individual Voluntary Arrangements', 'Proposal, creditor decision, variation and annual review, shaped by the IVA Protocol.'],
              ['Debt Relief Orders', 'Eligibility against configurable statutory limits, approved intermediary route, moratorium.'],
              ['Bankruptcy', 'Adjudicator application, fee handling, order and discharge.'],
              ['Breathing Space', 'Standard and mental health crisis moratoria, with the concurrency and repeat-use rules.'],
              ['Scotland', 'Protected Trust Deeds, sequestration including the Minimal Asset Process, and the Debt Arrangement Scheme.'],
            ].map(([title, body]) => (
              <div key={title} className="mk-card">
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 'var(--space-5)', color: 'var(--ink-muted)' }}>
            Each is configuration rather than code, which is why the list can grow without a
            release. Statutory thresholds are values you maintain, and the platform records
            which version was in force when a case was assessed.
          </p>
        </div>
      </section>
    </>
  );
}
