import { Badge } from '@solvenda/ui';
import type { DocumentSuggestion } from '@solvenda/comms';

/**
 * Something the client sent, and what to do with it.
 *
 * The whole point of the design is that the adviser never downloads this and
 * re-uploads it. Both ends are already on the server — the file was fetched the
 * moment the message arrived — so filing it is a decision, not a transfer.
 *
 * The suggestion leads because it is usually right and takes one click. It is
 * phrased as a question rather than an assertion, and the confidence is shown,
 * because a classifier that sounds certain trains people to stop reading. The
 * destination can be changed in the same control, and "not for the file" is
 * always available — a client sending a photo of their dog should not require
 * an adviser to invent a document type for it.
 */

const SIZE = (bytes: number | null): string => {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const KIND_MARK: Record<string, string> = {
  image: '▣', document: '▤', audio: '♪', voice: '♪', video: '▶', sticker: '☺',
};

export function AttachmentCard({
  attachment, caseId, suggestion, outstanding, onFile, onDismiss,
}: {
  attachment: {
    id: string; filename: string | null; contentType: string | null;
    byteSize: number | null; mediaKind: string | null;
    ingestStatus: string; ingestError: string | null;
    documentId: string | null; documentStatus: string | null;
  };
  caseId: string | null;
  suggestion: DocumentSuggestion;
  outstanding: readonly { key: string; label: string; state: string }[];
  onFile: (form: FormData) => Promise<void>;
  onDismiss: (form: FormData) => Promise<void>;
}) {
  const name = attachment.filename ?? 'Attachment';
  const filed = attachment.documentStatus === 'active';
  const waiting = attachment.ingestStatus === 'pending';
  const broken = ['failed', 'expired', 'infected'].includes(attachment.ingestStatus);

  return (
    <div className={`sv-attach${filed ? ' sv-attach--filed' : ''}`}
         // Dragging carries the attachment id, not the file. Both ends are
         // server-side, so a drop is an instruction and the server does the
         // copying — which is why this works at all with a 90MB statement.
         draggable={!filed && !waiting && !broken}
         data-attachment-id={attachment.id}
         data-document-type={suggestion.documentType}
         data-requirement={suggestion.satisfiesRequirement ?? ''}>
      <div className="sv-attach__head">
        <span className="sv-attach__icon" aria-hidden="true">
          {KIND_MARK[attachment.mediaKind ?? 'document'] ?? '▤'}
        </span>
        <span className="sv-attach__name">{name}</span>
        <span className="sv-attach__size">{SIZE(attachment.byteSize)}</span>
      </div>

      {waiting && (
        <p className="sv-attach__state">Receiving this file…</p>
      )}

      {broken && (
        <p className="sv-attach__state sv-attach__state--bad" role="alert">
          {attachment.ingestStatus === 'infected'
            ? 'This file failed a malware scan and was not kept.'
            : attachment.ingestError ?? 'This file could not be received.'}
        </p>
      )}

      {filed && (
        <p className="sv-attach__state">
          <Badge tone="positive">Filed to the case</Badge>
        </p>
      )}

      {!filed && !waiting && !broken && (
        <>
          {!caseId ? (
            <p className="sv-attach__state">
              Link this conversation to a case before filing it.
            </p>
          ) : (
            <form action={onFile} className="sv-attach__save">
              <input type="hidden" name="attachmentId" value={attachment.id} />
              <input type="hidden" name="caseId" value={caseId} />
              {/* Accepting the suggestion unchanged is recorded as exactly
                  that, so a file review can tell it apart from a person
                  choosing the type themselves. */}
              <input type="hidden" name="accepted" value="on" />

              <p className="sv-attach__suggest">
                {suggestion.because}
                <span className="sv-attach__confidence">
                  {Math.round(suggestion.confidence * 100)}% sure
                </span>
              </p>

              <div className="sv-attach__row">
                <label className="sv-attach__field">
                  <span className="sv-attach__label">File as</span>
                  <select className="sv-input sv-input--sm" name="documentType"
                          defaultValue={suggestion.documentType} aria-label="Document type">
                    {[...new Set([suggestion.documentType, 'bank-statement', 'payslip',
                                  'benefit-award', 'identity', 'proof-of-address',
                                  'creditor-letter', 'utility-bill', 'voice-note', 'other'])]
                      .map((t) => (
                        <option key={t} value={t}>
                          {t.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                        </option>
                      ))}
                  </select>
                </label>

                <label className="sv-attach__field">
                  <span className="sv-attach__label">Evidences</span>
                  <select className="sv-input sv-input--sm" name="satisfiesRequirement"
                          defaultValue={suggestion.satisfiesRequirement ?? ''}
                          aria-label="Requirement this evidences">
                    <option value="">Nothing in particular</option>
                    {outstanding.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </select>
                </label>

                <button className="sv-btn sv-btn--primary sv-btn--sm" type="submit">
                  Save to case
                </button>
              </div>
            </form>
          )}

          <form action={onDismiss} className="sv-attach__dismiss">
            <input type="hidden" name="attachmentId" value={attachment.id} />
            <input type="hidden" name="reason" value="Not a document for the case file" />
            <button className="sv-btn sv-btn--ghost sv-btn--sm" type="submit">
              Not for the file
            </button>
          </form>
        </>
      )}
    </div>
  );
}
