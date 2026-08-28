import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Compliance and QA',
  description: 'Consumer Duty outcome monitoring, vulnerability under FG21/1, tamper-evident audit and AI-assisted QA with human sign-off.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Compliance</p>
          <h1>Evidence, produced by the work</h1>
          <p>Compliance in this market is mostly a question of whether the file can answer a question later. Solvenda is built so that the answer accumulates as the work happens rather than being assembled when someone asks.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Who, what, when, why, source, before, after</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Every consequential action writes a ledger entry carrying all seven. Regulated actions are refused outright without a stated reason. Credential material is stripped from payloads before storage.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Tamper-evident, not merely append-only</h2>
          <p style={{ color: 'var(--ink-muted)' }}>The ledger is append-only by trigger and by revoked grants, and each entry is SHA-256 chained to its predecessor per firm. Verification recomputes the chain and reports the first divergence. Our own operator console recomputes every firm’s chain on load, because a firm should not be the one to discover a broken ledger.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Vulnerability as FG21/1 frames it</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Records are structured against the four drivers — health, life events, resilience, capability — with indicators, severity, agreed adjustments and separate disclosure control for what a creditor may be told. Health-related detail is special category data: it is stored only where a consent record permits it, and consent is versioned, purposed and independently withdrawable.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Consumer Duty outcome monitoring</h2>
          <p style={{ color: 'var(--ink-muted)' }}>PRIN 2A.9 asks firms to monitor the outcomes customers actually receive. The signals the platform already holds map onto the four outcomes — solution distribution and breakdown rates, fee-to-benefit where fees apply, comprehension checkpoints and reading level, time to contact and drop-off by cohort including vulnerable clients. The platform produces the evidence; it does not assert that a firm is compliant.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='What we do not claim' items={['We hold no certifications. No ISO 27001, no SOC 2, and no penetration test has been carried out.', 'Solvenda is not authorised by the FCA and does not give debt advice. Your regulatory obligations remain yours.', 'The erasure-versus-immutability question — how a subject erasure request reconciles with an append-only ledger — has a designed answer (remove the personal payload, preserve the event and its hash) that has not yet been reviewed by a data protection specialist. We have written that down rather than left it implied.']} />
        </div>
      </section>
    </>
  );
}
