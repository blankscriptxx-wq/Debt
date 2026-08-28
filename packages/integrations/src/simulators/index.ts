import { createHash } from 'node:crypto';
import type {
  AdapterContext, AdapterResult, BankSnapshot, CreditReferenceAdapter,
  CreditReport, IdentityAdapter, IdentityResult, OpenBankingAdapter,
  PaymentsAdapter, SignatureAdapter,
} from '../contracts.js';

/**
 * Sandbox simulators.
 *
 * These are not mocks. They are what the platform genuinely does today, because
 * no live vendor credentials exist, and every record they produce is marked
 * `simulated`. They behave like real providers - deterministic given the same
 * input, capable of returning a refer or a failure, and returning data shaped
 * exactly as the contract specifies - so the code around them is properly
 * exercised rather than always taking the happy path.
 *
 * Replacing one with a live adapter means implementing the same interface. No
 * calling code changes.
 */

function seedOf(...parts: string[]): Buffer {
  return createHash('sha256').update(parts.join('|')).digest();
}

function ok<T>(data: T, request: Record<string, unknown>,
               response: Record<string, unknown>): AdapterResult<T> {
  return { ok: true, data, requestSummary: request, responseSummary: response };
}

// ---------------------------------------------------------------------------

export class SimulatedOpenBanking implements OpenBankingAdapter {
  readonly category = 'open-banking' as const;
  readonly providerKey = 'sandbox-open-banking';
  readonly simulated = true;

  async beginConsent(ctx: AdapterContext, input: { redirectUrl: string; clientReference: string }) {
    const seed = seedOf(ctx.tenantId, input.clientReference);
    const consentId = `consent_${seed.toString('hex').slice(0, 16)}`;
    return ok(
      {
        consentId,
        authorisationUrl: `https://sandbox.invalid/authorise?consent=${consentId}`,
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      },
      { operation: 'beginConsent', clientReference: input.clientReference },
      { consentId, simulated: true },
    );
  }

  async fetchSnapshot(ctx: AdapterContext, input: { consentId: string; months: number }) {
    const seed = seedOf(ctx.tenantId, input.consentId);
    const months = Math.max(1, Math.min(input.months, 12));

    // A plausible household: salary in, rent and utilities out, plus grocery
    // spending that runs above what people typically declare.
    const categories: Record<string, number> = {
      'rent': 85_000,
      'food-and-housekeeping': 62_000 + (seed[0]! % 40) * 100,
      'travel': 18_000 + (seed[1]! % 30) * 100,
      'communications-and-leisure': 12_000 + (seed[2]! % 20) * 100,
      'personal-costs': 21_000 + (seed[3]! % 25) * 100,
    };

    const transactions = [];
    for (let month = 0; month < months; month++) {
      const bookedAt = new Date(Date.now() - month * 30 * 86_400_000);
      transactions.push({
        id: `txn_${seed.toString('hex').slice(0, 8)}_${month}_in`,
        bookedAt: bookedAt.toISOString(),
        description: 'SALARY PAYMENT',
        amountPence: 198_000,
        direction: 'credit' as const,
        suggestedCategory: 'earnings',
        categoryConfidence: 0.98,
        merchant: null,
      });
      for (const [category, amount] of Object.entries(categories)) {
        transactions.push({
          id: `txn_${seed.toString('hex').slice(0, 8)}_${month}_${category}`,
          bookedAt: bookedAt.toISOString(),
          description: category.replace(/-/g, ' ').toUpperCase(),
          amountPence: -amount,
          direction: 'debit' as const,
          suggestedCategory: category,
          // Categorisation is never certain, and the platform must handle that
          // rather than treating a suggestion as a fact.
          categoryConfidence: Math.round((0.72 + (seed[4]! % 25) / 100) * 100) / 100,
          merchant: null,
        });
      }
    }

    const snapshot: BankSnapshot = {
      accounts: [{
        id: `acct_${seed.toString('hex').slice(0, 10)}`,
        name: 'Current account', type: 'current',
        balancePence: 4_200 + (seed[5]! % 200) * 100,
      }],
      periodMonths: months,
      transactions,
      categorisedMonthlyTotals: categories,
    };

    return ok(snapshot,
      { operation: 'fetchSnapshot', consentId: input.consentId, months },
      { accounts: 1, transactionCount: transactions.length, simulated: true });
  }
}

// ---------------------------------------------------------------------------

export class SimulatedCreditReference implements CreditReferenceAdapter {
  readonly category = 'credit-reference' as const;
  readonly providerKey = 'sandbox-credit-reference';
  readonly simulated = true;

  async softSearch(ctx: AdapterContext, input: {
    firstName: string; lastName: string; dateOfBirth: string;
    postcode: string; addressLine1: string;
  }) {
    const seed = seedOf(ctx.tenantId, input.lastName, input.dateOfBirth, input.postcode);
    const count = 3 + (seed[0]! % 4);

    const report: CreditReport = {
      searchedAt: new Date().toISOString(),
      accounts: Array.from({ length: count }, (_, i) => ({
        creditorName: ['Halifax', 'Barclaycard', 'MBNA', 'Capital One',
                       'Lowell Financial', 'Very', 'Zopa'][(seed[i + 1]! % 7)]!,
        accountType: i % 3 === 0 ? 'credit-card' : i % 3 === 1 ? 'loan' : 'mail-order',
        balancePence: 40_000 + (seed[i + 2]! % 200) * 1_000,
        arrearsPence: seed[i + 3]! % 4 === 0 ? (seed[i + 3]! % 20) * 1_000 : 0,
        openedAt: new Date(Date.now() - (600 + seed[i + 4]! * 4) * 86_400_000)
          .toISOString().slice(0, 10),
        defaultedAt: seed[i + 5]! % 6 === 0
          ? new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10) : null,
        status: seed[i + 5]! % 6 === 0 ? 'defaulted' : 'active',
      })),
      publicRecords: [],
      addressesLinked: 1 + (seed[9]! % 3),
    };

    return ok(report,
      // The search itself is a record: a client can ask what was looked up.
      { operation: 'softSearch', surname: input.lastName, postcode: input.postcode,
        searchType: 'soft' },
      { accountsFound: report.accounts.length, simulated: true });
  }
}

// ---------------------------------------------------------------------------

export class SimulatedIdentity implements IdentityAdapter {
  readonly category = 'identity-verification' as const;
  readonly providerKey = 'sandbox-identity';
  readonly simulated = true;

  async verify(ctx: AdapterContext, input: {
    firstName: string; lastName: string; dateOfBirth: string;
    postcode: string; addressLine1: string;
  }) {
    const seed = seedOf(ctx.tenantId, input.lastName, input.dateOfBirth);
    // Roughly one in eight refers, so the refer path is genuinely exercised.
    const outcome: IdentityResult['outcome'] = seed[0]! % 8 === 0 ? 'refer' : 'pass';

    const result: IdentityResult = {
      outcome,
      checks: [
        { name: 'name-and-address', outcome: 'pass', detail: 'Matched on the electoral roll' },
        { name: 'date-of-birth', outcome: 'pass', detail: 'Matched' },
        { name: 'mortality', outcome: 'pass', detail: 'No match' },
        { name: 'sanctions-and-pep', outcome: outcome === 'refer' ? 'refer' : 'pass',
          detail: outcome === 'refer' ? 'Possible match requiring manual review' : 'No match' },
      ],
      sanctionsMatch: false,
      pepMatch: outcome === 'refer',
      reference: `idv_${seed.toString('hex').slice(0, 12)}`,
    };

    return ok(result,
      { operation: 'verify', surname: input.lastName, postcode: input.postcode },
      { outcome, simulated: true });
  }
}

// ---------------------------------------------------------------------------

export class SimulatedSignature implements SignatureAdapter {
  readonly category = 'e-signature' as const;
  readonly providerKey = 'sandbox-e-signature';
  readonly simulated = true;

  async requestSignature(ctx: AdapterContext, input: {
    documentId: string; signerName: string; signerEmail: string; documentTitle: string;
  }) {
    const seed = seedOf(ctx.tenantId, input.documentId);
    const envelopeId = `env_${seed.toString('hex').slice(0, 14)}`;
    return ok(
      {
        envelopeId,
        signingUrl: `https://sandbox.invalid/sign/${envelopeId}`,
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      { operation: 'requestSignature', documentId: input.documentId, title: input.documentTitle },
      { envelopeId, simulated: true },
    );
  }

  async status(ctx: AdapterContext, input: { envelopeId: string }) {
    const seed = seedOf(ctx.tenantId, input.envelopeId);
    const signed = seed[0]! % 2 === 0;
    return ok(
      {
        status: (signed ? 'signed' : 'pending') as 'signed' | 'pending',
        signedAt: signed ? new Date().toISOString() : null,
        evidence: signed
          ? { method: 'simulated', ipRecorded: false, auditTrailAvailable: false }
          : {},
      },
      { operation: 'status', envelopeId: input.envelopeId },
      { status: signed ? 'signed' : 'pending', simulated: true },
    );
  }
}

// ---------------------------------------------------------------------------

export class SimulatedPayments implements PaymentsAdapter {
  readonly category = 'payments' as const;
  readonly providerKey = 'sandbox-payments';
  readonly simulated = true;

  async createMandate(ctx: AdapterContext, input: {
    accountName: string; reference: string; amountPence: number; dayOfMonth: number;
  }) {
    if (input.amountPence <= 0) {
      return { ok: false, data: null, error: 'A mandate needs an amount above zero',
               requestSummary: { operation: 'createMandate', reference: input.reference },
               responseSummary: { rejected: true } };
    }
    if (input.dayOfMonth < 1 || input.dayOfMonth > 28) {
      // 29-31 do not exist in every month; real schemes reject them too.
      return { ok: false, data: null,
               error: 'Collection day must be between 1 and 28',
               requestSummary: { operation: 'createMandate', reference: input.reference },
               responseSummary: { rejected: true } };
    }

    const seed = seedOf(ctx.tenantId, input.reference);
    const first = new Date();
    first.setMonth(first.getMonth() + 1);
    first.setDate(input.dayOfMonth);

    return ok(
      {
        mandateId: `mandate_${seed.toString('hex').slice(0, 12)}`,
        status: 'pending-first-collection',
        firstCollectionOn: first.toISOString().slice(0, 10),
      },
      { operation: 'createMandate', reference: input.reference,
        amountPence: input.amountPence, dayOfMonth: input.dayOfMonth },
      { simulated: true },
    );
  }

  async cancelMandate(ctx: AdapterContext, input: { mandateId: string; reason: string }) {
    return ok({ cancelled: true },
      { operation: 'cancelMandate', mandateId: input.mandateId, reason: input.reason },
      { simulated: true });
  }
}

export const SIMULATED_PROVIDERS = [
  {
    key: 'sandbox-open-banking', name: 'Sandbox Open Banking', category: 'open-banking',
    description: 'Deterministic account information for development and demonstration.',
    requiredSecrets: ['clientId', 'clientSecret'], simulated: true,
    adapter: () => new SimulatedOpenBanking(),
  },
  {
    key: 'sandbox-credit-reference', name: 'Sandbox credit reference',
    category: 'credit-reference',
    description: 'Soft search returning a plausible account list. Never a hard search.',
    requiredSecrets: ['apiKey'], simulated: true,
    adapter: () => new SimulatedCreditReference(),
  },
  {
    key: 'sandbox-identity', name: 'Sandbox identity verification',
    category: 'identity-verification',
    description: 'Electronic identity and AML screening, including a refer outcome.',
    requiredSecrets: ['apiKey'], simulated: true,
    adapter: () => new SimulatedIdentity(),
  },
  {
    key: 'sandbox-e-signature', name: 'Sandbox e-signature', category: 'e-signature',
    description: 'Signature envelopes and status polling.',
    requiredSecrets: ['apiKey'], simulated: true,
    adapter: () => new SimulatedSignature(),
  },
  {
    key: 'sandbox-payments', name: 'Sandbox payments', category: 'payments',
    description: 'Direct debit mandates, with the validation a real scheme applies.',
    requiredSecrets: ['apiKey', 'creditorId'], simulated: true,
    adapter: () => new SimulatedPayments(),
  },
] as const;
