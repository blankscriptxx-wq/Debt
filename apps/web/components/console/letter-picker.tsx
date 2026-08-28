import { Badge } from '@solvenda/ui';
import type { TemplateSummary } from '@solvenda/comms';

/**
 * The firm's letters, in the composer.
 *
 * Most of what a debt advice firm sends is not written from scratch — an
 * appointment confirmation, a request for a payslip, a reminder that a review
 * is due — and on WhatsApp the distinction is not a convenience. Once
 * twenty-four hours have passed since the client last wrote, an approved
 * template is **the only thing the platform will carry**, so this stops being
 * an accelerator and becomes the only way to reach somebody.
 *
 * Every template is shown, including the ones that cannot be sent, with the
 * reason. An adviser needs to know that the letter they want exists and is
 * waiting on the provider; hiding it makes the software look as though the
 * firm never wrote it.
 *
 * Rendered as nested disclosures rather than a dropdown that swaps a form,
 * because a picker where choosing a letter reveals its fields needs client-side
 * state, and this needs to work for somebody on a keyboard reading a screen at
 * 200%.
 */

/** `firstName` is a column name. "First name" is what an adviser is being asked for. */
function humanise(variable: string): string {
  const spaced = variable.replace(/[._-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const HINTS: Record<string, string> = {
  when: 'e.g. Thursday 4 September, 2pm',
  document: 'e.g. a recent bank statement',
  caseReference: 'e.g. DMP-0003',
};

export function LetterPicker({
  templates, signature, windowOpen, clientName, onSend,
}: {
  templates: readonly TemplateSummary[];
  /** How the message will be signed. Null when the account has no name on it. */
  signature: string | null;
  windowOpen: boolean;
  clientName: string;
  onSend: (form: FormData) => Promise<void>;
}) {
  if (templates.length === 0) return null;

  return (
    // Open by default when it is the only thing that will reach the client.
    <details className="sv-letters" open={!windowOpen}>
      <summary className="sv-letters__summary">
        Send a letter
        <span className="sv-letters__count">
          {templates.filter((t) => t.sendable).length} available
        </span>
      </summary>

      <p className="sv-letters__note">
        {windowOpen
          ? `A letter goes to ${clientName} with your name on it. Nothing here gives advice — `
            + 'a recommendation is recorded on the case, not sent at the press of a button.'
          : `WhatsApp will only carry an approved template until ${clientName} writes again.`}
      </p>

      {templates.map((template) => (
        <details key={template.id}
                 className={`sv-letter${template.sendable ? '' : ' sv-letter--blocked'}`}>
          <summary className="sv-letter__summary">
            <span className="sv-letter__name">{template.name}</span>
            {template.providerCategory && (
              <span className="sv-letter__category">{template.providerCategory}</span>
            )}
            {!template.sendable && <Badge tone="attention">Cannot be sent</Badge>}
          </summary>

          <p className="sv-letter__body">{template.body}</p>

          {template.sendable ? (
            <form action={onSend} className="sv-letter__form">
              <input type="hidden" name="templateKey" value={template.key} />

              {template.requiredVariables.map((variable) => (
                <label key={variable} className="sv-letter__field">
                  <span className="sv-letter__label">{humanise(variable)}</span>
                  <input className="sv-input" name={`var.${variable}`} required
                         placeholder={HINTS[variable] ?? ''} />
                </label>
              ))}

              {/* Stated, not offered. The name is read from the account of
                  whoever is signed in, so there is nothing here to change — and
                  saying so is the point: a client can rely on it. */}
              {signature ? (
                <p className="sv-letter__signed">
                  Signed <strong>{signature}</strong> — taken from your account.
                </p>
              ) : (
                <p className="sv-letter__blocked">
                  Your account has no name recorded, so nothing can be sent to a client
                  under it. An administrator can add one.
                </p>
              )}

              <button className="sv-btn sv-btn--primary sv-btn--sm" type="submit"
                      disabled={!signature}>
                Send this letter
              </button>
            </form>
          ) : (
            <p className="sv-letter__blocked" role="note">{template.blockedBecause}</p>
          )}
        </details>
      ))}
    </details>
  );
}
