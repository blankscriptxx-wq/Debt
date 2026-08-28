import type { Metadata } from 'next';
import { Claim, HonestSection } from '@/components/layout';

export const metadata: Metadata = {
  title: 'Security',
  description: 'Tenant isolation enforced by the database, Argon2id and TOTP, encrypted integration credentials, and an audit ledger that detects tampering.',
};

export default function Page() {
  return (
    <>
      <section className="mk-hero">
        <div className="mk-container">
          <p className="mk-eyebrow">Security</p>
          <h1>Isolation you can explain to a procurement team</h1>
          <p>The question a firm’s IT reviewer asks is simple: what stops my data reaching another firm? "We add a tenant id to every query" is not an answer, because the failure mode is a developer forgetting.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>The database enforces it, not the application</h2>
          <p style={{ color: 'var(--ink-muted)' }}>The application connects as a role that owns nothing and cannot bypass row-level security. Every tenant table forces RLS and defaults its tenant column from the transaction context. A query written without a filter returns zero rows; an insert aimed at another firm is rejected by the policy. The schema owner is subject to the same policies, so migrations and owner-level access cannot cross tenants either.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Cross-tenant access is a different role, a stated reason and a clock</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Platform operators hold no permissions inside any firm — the authorisation engine refuses every tenant permission to an operator principal. Reading a firm’s data requires a separate database role, an explicit context flag, a time-boxed grant of at most eight hours and a recorded reason. Write access additionally requires a second operator to approve.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Credentials and secrets</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Passwords use Argon2id at OWASP-recommended parameters. Session tokens are stored only as SHA-256 hashes. Second factors are TOTP, required for every regulated action regardless of a firm’s general posture. Integration credentials are encrypted with a per-tenant key derived from a master key and decrypted inside a function that refuses another firm’s install.</p>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <h2>Failure modes we chose deliberately</h2>
          <p style={{ color: 'var(--ink-muted)' }}>Account lockout compares times in the database rather than the application, because a driver returning a timestamp as a string once made a lockout silently never fire. Failed-login counting increments in the database rather than read-then-write. Sign-out is a POST, because a prefetched link would end sessions on page render. Each of those was a real bug, found by a test, and each is now covered by one.</p>
        </div>
      </section>


      <section className="mk-section">
        <div className="mk-container mk-narrow">
          <HonestSection title='Production readiness, stated plainly' items={['UK-only data residency is not achievable on the current hosting; EU region is. Moving to a UK region is deployment work, not a code change.', 'SSO and SAML exist as seams, not implementations. WebAuthn is not built.', 'No penetration test, no independent security assessment, and no bug bounty.', 'Disaster recovery is designed but untested: no restore drill has been performed.']} />
        </div>
      </section>
    </>
  );
}
