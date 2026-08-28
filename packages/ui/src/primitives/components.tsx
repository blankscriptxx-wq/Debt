import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes } from 'react';

/**
 * The primitive set.
 *
 * Deliberately small. A design system for dense operational software earns its
 * keep by making the twenty things advisers do all day consistent, not by
 * covering every case someone might want.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// --- Buttons ---------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'regulated';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({
  variant = 'secondary', size = 'md', loading, children, className, disabled, ...rest
}: ButtonProps) {
  return (
    <button
      className={cx('sv-btn', `sv-btn--${variant}`, `sv-btn--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="sv-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// --- Status ----------------------------------------------------------------

export type Tone = 'neutral' | 'positive' | 'attention' | 'critical' | 'accent' | 'regulated';

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  /** Rendered before the label; status is never colour alone. */
  icon?: ReactNode;
  title?: string;
}

export function Badge({ tone = 'neutral', children, icon, title }: BadgeProps) {
  return (
    <span className={cx('sv-badge', `sv-badge--${tone}`)} title={title}>
      {icon ? <span className="sv-badge__icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

/**
 * Marks an action or record that carries regulatory weight, so it never looks
 * like ordinary work.
 */
export function RegulatedMark({ children }: { children?: ReactNode }) {
  return (
    <span className="sv-regulated-mark">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 1l4 2v3.2C10 8.6 8.3 10.6 6 11.3 3.7 10.6 2 8.6 2 6.2V3l4-2z"
              fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      {children ?? 'Regulated'}
    </span>
  );
}

// --- Layout ----------------------------------------------------------------

export function Card({
  title, subtitle, actions, children, className, padded = true,
}: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string; padded?: boolean;
}) {
  return (
    <section className={cx('sv-card', className)}>
      {(title || actions) && (
        <header className="sv-card__header">
          <div>
            {title && <h2 className="sv-card__title">{title}</h2>}
            {subtitle && <p className="sv-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="sv-card__actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'sv-card__body' : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({
  eyebrow, title, meta, actions,
}: { eyebrow?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="sv-page-header">
      <div className="sv-page-header__text">
        {eyebrow && <p className="sv-page-header__eyebrow">{eyebrow}</p>}
        <h1 className="sv-page-header__title">{title}</h1>
        {meta && <div className="sv-page-header__meta">{meta}</div>}
      </div>
      {actions && <div className="sv-page-header__actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title, detail, action,
}: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="sv-empty">
      <p className="sv-empty__title">{title}</p>
      {detail && <p className="sv-empty__detail">{detail}</p>}
      {action}
    </div>
  );
}

// --- Data ------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Right-aligns and applies tabular figures. */
  numeric?: boolean;
  width?: string;
}

export function DataTable<T>({
  columns, rows, getKey, empty, onRowHref,
}: {
  columns: Column<T>[];
  rows: readonly T[];
  getKey: (row: T) => string;
  empty?: ReactNode;
  onRowHref?: (row: T) => string;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  }
  return (
    <div className="sv-table-wrap">
      <table className="sv-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined}
                  className={c.numeric ? 'sv-num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = onRowHref?.(row);
            return (
              <tr key={getKey(row)} className={href ? 'sv-table__row--link' : undefined}>
                {columns.map((c, i) => (
                  <td key={c.key} className={c.numeric ? 'sv-num' : undefined}>
                    {href && i === 0
                      ? <a className="sv-table__link" href={href}>{c.render(row)}</a>
                      : c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StatTile({
  label, value, change, tone = 'neutral', footnote,
}: {
  label: string; value: ReactNode; change?: ReactNode; tone?: Tone; footnote?: ReactNode;
}) {
  return (
    <div className={cx('sv-stat', `sv-stat--${tone}`)}>
      <p className="sv-stat__label">{label}</p>
      <p className="sv-stat__value">{value}</p>
      {change && <p className="sv-stat__change">{change}</p>}
      {footnote && <p className="sv-stat__footnote">{footnote}</p>}
    </div>
  );
}

/**
 * Case health, shown as a figure with its band. The score is never presented
 * alone - the drivers sit beside it, because a number an adviser cannot take
 * apart is a number they will stop trusting.
 */
export function HealthMeter({
  score, band, summary,
}: { score: number; band: 'healthy' | 'monitor' | 'attention' | 'at-risk'; summary: string }) {
  const tone: Tone =
    band === 'healthy' ? 'positive'
    : band === 'monitor' ? 'accent'
    : band === 'attention' ? 'attention'
    : 'critical';
  const label = { healthy: 'Healthy', monitor: 'Monitor',
                  attention: 'Needs attention', 'at-risk': 'At risk' }[band];
  return (
    <div className="sv-health">
      <div className={cx('sv-health__dial', `sv-health__dial--${tone}`)}
           role="img" aria-label={`Case health ${score} out of 100, ${label}`}>
        <span className="sv-health__score">{score}</span>
        <span className="sv-health__unit">/100</span>
      </div>
      <div className="sv-health__text">
        <Badge tone={tone}>{label}</Badge>
        <p className="sv-health__summary">{summary}</p>
      </div>
    </div>
  );
}

export function SignalRow({
  severity, title, detail, sources, action,
}: {
  severity: 'informational' | 'attention' | 'urgent' | 'critical';
  title: string; detail: string;
  sources: { label: string }[];
  action?: string | null;
}) {
  const tone: Tone =
    severity === 'critical' ? 'critical'
    : severity === 'urgent' ? 'critical'
    : severity === 'attention' ? 'attention'
    : 'neutral';
  const label = { informational: 'For information', attention: 'Attention',
                  urgent: 'Urgent', critical: 'Critical' }[severity];
  return (
    <li className={cx('sv-signal', `sv-signal--${tone}`)}>
      <div className="sv-signal__head">
        <Badge tone={tone}>{label}</Badge>
        <h3 className="sv-signal__title">{title}</h3>
      </div>
      <p className="sv-signal__detail">{detail}</p>
      {action && <p className="sv-signal__action"><strong>Next:</strong> {action}</p>}
      {sources.length > 0 && (
        <p className="sv-signal__sources">
          From: {sources.map((s) => s.label).join(' · ')}
        </p>
      )}
    </li>
  );
}

/**
 * Shown wherever the platform is standing in for an integration it does not
 * have. Being explicit about this is a product decision: a firm that believes a
 * message was sent when it was not has a worse problem than one that knows.
 */
export function SimulatedNotice({ what }: { what: string }) {
  return (
    <p className="sv-simulated" role="note">
      <strong>Simulated.</strong> {what} No live provider is connected, so nothing
      left the platform.
    </p>
  );
}

export function Field({
  label, hint, error, children, required,
}: { label: string; hint?: string; error?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="sv-field">
      <span className="sv-field__label">
        {label}
        {required && <span className="sv-field__required" aria-label="required"> *</span>}
      </span>
      {hint && <span className="sv-field__hint">{hint}</span>}
      {children}
      {error && <span className="sv-field__error" role="alert">{error}</span>}
    </label>
  );
}

export function Money({ pence, showSign }: { pence: number; showSign?: boolean }) {
  const negative = pence < 0;
  const body = `£${(Math.abs(pence) / 100).toLocaleString('en-GB',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <span className={cx('sv-money', negative && 'sv-money--negative')}>
      {negative ? `-${body}` : showSign ? `+${body}` : body}
    </span>
  );
}

export function Stack({ gap = 4, children, className, ...rest }:
  { gap?: 1 | 2 | 3 | 4 | 5 | 6; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('sv-stack', `sv-stack--${gap}`, className)} {...rest}>{children}</div>
  );
}

export function Grid({ min = '260px', children }: { min?: string; children: ReactNode }) {
  return (
    <div className="sv-grid" style={{ ['--sv-grid-min' as string]: min }}>{children}</div>
  );
}

export interface DemoAccountOption {
  key: string;
  label: string;
  detail: string;
  email: string;
}

/**
 * The development sign-in panel.
 *
 * Renders one button per account, each a form posting that account's email to
 * the server action the portal supplies. It is styled as a warning on purpose:
 * this is a hole in authentication and it should look like one on every screen
 * it appears on, so nobody mistakes it for a product feature.
 *
 * Callers are expected to render it only when demo sign-in is enabled. The
 * server action refuses independently, so a stale render cannot let anyone in.
 */
export function DemoSignIn({
  accounts, action, note,
}: {
  accounts: readonly DemoAccountOption[];
  action: (formData: FormData) => void | Promise<void>;
  note?: string;
}) {
  return (
    <div className="sv-demo">
      <p className="sv-demo__label">
        <span aria-hidden="true">⚠</span> Development sign-in
      </p>
      <p className="sv-demo__note">
        {note ?? 'One click, no password and no second factor. Enabled by an environment '
          + 'variable and intended for development only.'}
      </p>
      <div className="sv-demo__list">
        {accounts.map((account) => (
          <form key={account.key} action={action}>
            <input type="hidden" name="email" value={account.email} />
            <button className="sv-demo__btn" type="submit">
              <strong>{account.label}</strong>
              <span>{account.detail}</span>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
