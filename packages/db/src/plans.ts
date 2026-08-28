/**
 * The commercial plan catalogue.
 *
 * Lives here rather than inside the seed script because three places need the
 * same numbers: the seeded `plans` rows, Solvenda Control, and the public
 * pricing page. A price quoted on a website that disagrees with the price in
 * the database is the kind of error that is only ever found by a customer, so
 * they read from one definition.
 *
 * Positioned as business-critical enterprise software rather than a per-seat
 * tool: a platform fee that reflects what the system replaces, seats on top,
 * and usage metered where our cost is genuinely variable (AI tokens, Open
 * Banking calls, messages, storage). Figures are the recommended starting
 * position from docs/commercial/pricing.md, not observed contract values -
 * private vendors in this market do not publish.
 */
export const PLANS = [
  {
    key: 'practice', name: 'Practice', sortOrder: 1,
    description: 'For a single-office firm establishing itself. Core case management, ' +
      'one jurisdiction, standard support.',
    platformFeePence: 95_000, perSeatPence: 9_500, includedSeats: 5,   // £950 / £95
    features: ['case-management', 'client-portal', 'workflows', 'standard-reporting'],
    usageTerms: {
      'ai.tokens': { included: 0, note: 'Case Intelligence narrative only' },
      'open-banking.calls': { includedPerMonth: 250, overagePence: 45 },
      'comms.messages': { includedPerMonth: 2_000, overagePence: 4 },
      'storage.gb': { includedGb: 50, overagePencePerGb: 60 },
    },
    minimumTermMonths: 12, supportTier: 'standard',
  },
  {
    key: 'firm', name: 'Firm', sortOrder: 2,
    description: 'For a multi-team firm running several solutions. Every case type, ' +
      'full AI layer, compliance and QA, priority support.',
    platformFeePence: 285_000, perSeatPence: 8_500, includedSeats: 20, // £2,850 / £85
    features: ['case-management', 'client-portal', 'workflows', 'ai-intelligence',
               'ai-qa', 'compliance-monitoring', 'creditor-portal', 'introducer-portal',
               'public-api', 'advanced-reporting'],
    usageTerms: {
      'ai.tokens': { includedPencePerMonth: 40_000, overageMultiplier: 1.4 },
      'open-banking.calls': { includedPerMonth: 2_500, overagePence: 38 },
      'comms.messages': { includedPerMonth: 25_000, overagePence: 3 },
      'storage.gb': { includedGb: 500, overagePencePerGb: 50 },
    },
    minimumTermMonths: 24, supportTier: 'priority',
  },
  {
    key: 'enterprise', name: 'Enterprise', sortOrder: 3,
    description: 'For a group operating at scale across jurisdictions. Everything in Firm, ' +
      'plus SSO, custom retention, a named contact and contractual service levels.',
    platformFeePence: 750_000, perSeatPence: 7_000, includedSeats: 75, // £7,500 / £70
    features: ['case-management', 'client-portal', 'workflows', 'ai-intelligence',
               'ai-qa', 'compliance-monitoring', 'creditor-portal', 'introducer-portal',
               'public-api', 'advanced-reporting', 'sso', 'custom-retention',
               'sandbox-environment', 'migration-service'],
    usageTerms: {
      'ai.tokens': { includedPencePerMonth: 200_000, overageMultiplier: 1.25 },
      'open-banking.calls': { includedPerMonth: 15_000, overagePence: 30 },
      'comms.messages': { includedPerMonth: 150_000, overagePence: 2 },
      'storage.gb': { includedGb: 2_000, overagePencePerGb: 40 },
    },
    minimumTermMonths: 36, supportTier: 'enterprise',
  },
] as const;

export type Plan = (typeof PLANS)[number];

/**
 * Pence to a string a finance director can check.
 *
 * Lives beside the figures because the one pricing bug this project has
 * actually had was a plan fee written as pence when pounds were meant, and it
 * was caught by asserting the *rendered* figure rather than the stored one.
 */
export function poundsFromPence(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}
