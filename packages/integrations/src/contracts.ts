import { z } from 'zod';

/**
 * Integration contracts.
 *
 * A category defines what the platform needs; a provider implements it. The
 * platform depends on the contract, never on a provider, so a firm changing
 * Open Banking supplier is a configuration change for them rather than a
 * release for us. It is also what makes a marketplace possible without the
 * codebase accumulating a folder per vendor.
 *
 * Every adapter shipped today is a sandbox simulator. That is stated in the
 * provider record, surfaced in the console, and recorded on every call.
 */

export type IntegrationCategory =
  | 'open-banking' | 'credit-reference' | 'identity-verification' | 'e-signature'
  | 'payments' | 'email' | 'sms' | 'whatsapp' | 'telephony' | 'accounting'
  | 'document-storage' | 'creditor-data' | 'insolvency-service' | 'companies-house';

export interface AdapterContext {
  tenantId: string;
  caseId?: string | null;
  clientId?: string | null;
  /** Resolves a named secret for this install. Adapters never see the store. */
  secret: (name: string) => Promise<string | null>;
  config: Record<string, unknown>;
}

export interface AdapterResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
  /** Summaries are what gets stored; raw payloads are not retained. */
  requestSummary: Record<string, unknown>;
  responseSummary: Record<string, unknown>;
}

// --- Open Banking ----------------------------------------------------------

export const bankTransactionSchema = z.object({
  id: z.string(),
  bookedAt: z.string(),
  description: z.string(),
  amountPence: z.number().int(),
  direction: z.enum(['credit', 'debit']),
  /** SFS category the provider suggests. Never applied without a person. */
  suggestedCategory: z.string().nullable(),
  categoryConfidence: z.number().min(0).max(1).nullable(),
  merchant: z.string().nullable(),
});
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

export const bankSnapshotSchema = z.object({
  accounts: z.array(z.object({
    id: z.string(), name: z.string(), type: z.string(),
    balancePence: z.number().int(),
  })),
  periodMonths: z.number().int(),
  transactions: z.array(bankTransactionSchema),
  /** Monthly averages by SFS category, ready to compare against declared. */
  categorisedMonthlyTotals: z.record(z.string(), z.number().int()),
});
export type BankSnapshot = z.infer<typeof bankSnapshotSchema>;

export interface OpenBankingAdapter {
  readonly category: 'open-banking';
  readonly providerKey: string;
  readonly simulated: boolean;
  /** Starts consent; returns the URL the client is sent to. */
  beginConsent(ctx: AdapterContext, input: { redirectUrl: string; clientReference: string }):
    Promise<AdapterResult<{ consentId: string; authorisationUrl: string; expiresAt: string }>>;
  fetchSnapshot(ctx: AdapterContext, input: { consentId: string; months: number }):
    Promise<AdapterResult<BankSnapshot>>;
}

// --- Credit reference ------------------------------------------------------

export const creditReportSchema = z.object({
  searchedAt: z.string(),
  accounts: z.array(z.object({
    creditorName: z.string(),
    accountType: z.string(),
    balancePence: z.number().int(),
    arrearsPence: z.number().int(),
    openedAt: z.string().nullable(),
    defaultedAt: z.string().nullable(),
    status: z.string(),
  })),
  publicRecords: z.array(z.object({
    type: z.string(), date: z.string(), detail: z.string(),
  })),
  addressesLinked: z.number().int(),
});
export type CreditReport = z.infer<typeof creditReportSchema>;

export interface CreditReferenceAdapter {
  readonly category: 'credit-reference';
  readonly providerKey: string;
  readonly simulated: boolean;
  /**
   * A soft search only. A hard search leaves a footprint on the client's file
   * and is never appropriate for debt advice.
   */
  softSearch(ctx: AdapterContext, input: {
    firstName: string; lastName: string; dateOfBirth: string;
    postcode: string; addressLine1: string;
  }): Promise<AdapterResult<CreditReport>>;
}

// --- Identity verification -------------------------------------------------

export const identityResultSchema = z.object({
  outcome: z.enum(['pass', 'refer', 'fail']),
  checks: z.array(z.object({
    name: z.string(), outcome: z.enum(['pass', 'refer', 'fail']), detail: z.string(),
  })),
  sanctionsMatch: z.boolean(),
  pepMatch: z.boolean(),
  reference: z.string(),
});
export type IdentityResult = z.infer<typeof identityResultSchema>;

export interface IdentityAdapter {
  readonly category: 'identity-verification';
  readonly providerKey: string;
  readonly simulated: boolean;
  verify(ctx: AdapterContext, input: {
    firstName: string; lastName: string; dateOfBirth: string;
    postcode: string; addressLine1: string;
  }): Promise<AdapterResult<IdentityResult>>;
}

// --- E-signature -----------------------------------------------------------

export interface SignatureAdapter {
  readonly category: 'e-signature';
  readonly providerKey: string;
  readonly simulated: boolean;
  requestSignature(ctx: AdapterContext, input: {
    documentId: string; signerName: string; signerEmail: string; documentTitle: string;
  }): Promise<AdapterResult<{ envelopeId: string; signingUrl: string; expiresAt: string }>>;
  status(ctx: AdapterContext, input: { envelopeId: string }):
    Promise<AdapterResult<{ status: 'pending' | 'signed' | 'declined' | 'expired';
                            signedAt: string | null; evidence: Record<string, unknown> }>>;
}

// --- Payments --------------------------------------------------------------

export interface PaymentsAdapter {
  readonly category: 'payments';
  readonly providerKey: string;
  readonly simulated: boolean;
  createMandate(ctx: AdapterContext, input: {
    accountName: string; reference: string; amountPence: number; dayOfMonth: number;
  }): Promise<AdapterResult<{ mandateId: string; status: string; firstCollectionOn: string }>>;
  cancelMandate(ctx: AdapterContext, input: { mandateId: string; reason: string }):
    Promise<AdapterResult<{ cancelled: boolean }>>;
}

export type AnyAdapter =
  | OpenBankingAdapter | CreditReferenceAdapter | IdentityAdapter
  | SignatureAdapter | PaymentsAdapter;
