import { requireClient, query } from '@/lib/session';
import { loadClientDocuments } from '@/lib/data';
import { ClientShell } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const session = await requireClient();
  const documents = await query(session, (db) => loadClientDocuments(db, session.clientId));

  return (
    <ClientShell firmName={session.firmName} firstName={session.firstName} current="documents">
      <h1 className="cp-h1">Documents</h1>
      <p className="cp-lede">
        Anything you send us, and anything we send you.
      </p>

      <div className="cp-card cp-card--action">
        <h2 className="cp-card__title">Send us a document</h2>
        <p style={{ marginTop: 0, color: 'var(--ink-muted)' }}>
          A photo of a payslip or a bank statement is fine. It does not need to be neat.
        </p>
        <p className="sv-simulated" role="note">
          <strong>Not yet connected.</strong> Uploading needs document storage, which is not
          wired up in this build. Nothing you choose here would be saved, so the control is
          disabled rather than pretending to work.
        </p>
        <button className="cp-btn cp-btn--secondary" disabled
                style={{ marginTop: 'var(--space-4)', opacity: 0.6 }}>
          Choose a file
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="cp-card">
          <p style={{ margin: 0 }}>You have not sent us anything yet.</p>
        </div>
      ) : (
        documents.map((document) => (
          <div key={document.id} className="cp-card">
            <p style={{ margin: 0, fontWeight: 600 }}>{document.filename}</p>
            <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--ink-muted)',
                        fontSize: 'var(--text-base)' }}>
              {document.direction === 'inbound' ? 'You sent this' : 'We sent this'}
              {' · '}
              {new Date(document.uploadedAt).toLocaleDateString('en-GB',
                { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            {document.signatureStatus === 'pending' && (
              <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--attention)' }}>
                This is waiting for your signature.
              </p>
            )}
          </div>
        ))
      )}
    </ClientShell>
  );
}
