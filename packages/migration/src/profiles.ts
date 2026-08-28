import type { MigrationPlan } from './mapping.js';

/**
 * Starting profiles for the systems firms actually migrate from.
 *
 * These are informed guesses at the shape of an export, not documented
 * schemas: the vendors do not publish theirs, and no export from any of them
 * has been seen. A firm adjusts the mapping against a real extract and the
 * dry-run report tells them what they missed. That is the honest position, and
 * it is stated in the profile itself so nobody mistakes a template for a
 * certified connector.
 */

export interface MigrationProfile {
  key: string;
  name: string;
  description: string;
  /** What a firm should expect to change. */
  caveats: string[];
  plan: MigrationPlan;
}

const CLIENT_FIELDS = [
  { target: 'reference', source: 'client_ref', required: true,
    transform: { type: 'trim' as const },
    note: 'Kept as the firm\'s existing reference so staff can still find people by it.' },
  { target: 'first_name', source: 'forename', required: true,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'last_name', source: 'surname', required: true,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'date_of_birth', source: 'dob', required: false,
    transform: { type: 'date' as const, format: 'uk' as const },
    note: 'Legacy systems in this market usually store dd/mm/yyyy.' },
  { target: 'email', source: 'email_address', required: false,
    transform: { type: 'lowercase' as const }, note: '' },
  { target: 'phone_mobile', source: 'mobile', required: false,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'address_line1', source: 'addr1', required: false,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'address_city', source: 'town', required: false,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'address_postcode', source: 'postcode', required: false,
    transform: { type: 'uppercase' as const }, note: '' },
  { target: 'jurisdiction', source: 'region', required: false,
    transform: {
      type: 'lookup' as const,
      table: { 'EW': 'england-wales', 'SC': 'scotland', 'NI': 'northern-ireland',
               'ENG': 'england-wales', 'WAL': 'england-wales' },
      fallback: 'england-wales',
    },
    note: 'Jurisdiction decides which solutions are even available, so a wrong value here ' +
          'is not cosmetic. The fallback is England and Wales; check Scottish cases.' },
  { target: 'household_adults', source: 'adults', required: false,
    transform: { type: 'copy' as const }, note: '' },
  { target: 'household_children', source: 'children', required: false,
    transform: { type: 'copy' as const }, note: '' },
];

const DEBT_FIELDS = [
  { target: 'case_id', source: 'case_ref', required: true,
    transform: { type: 'trim' as const },
    note: 'Resolved through the identity map built while migrating cases.' },
  { target: 'creditor_name', source: 'creditor', required: true,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'account_reference', source: 'account_no', required: false,
    transform: { type: 'trim' as const }, note: '' },
  { target: 'balance_pence', source: 'balance', required: true,
    transform: { type: 'pounds-to-pence' as const },
    note: 'Legacy systems store pounds as a decimal; the platform stores integer pence.' },
  { target: 'arrears_pence', source: 'arrears', required: false,
    transform: { type: 'pounds-to-pence' as const }, note: '' },
  { target: 'is_priority', source: 'priority_flag', required: false,
    transform: { type: 'boolean' as const, trueValues: ['1', 'Y', 'y', 'true', 'TRUE'] },
    note: 'Priority debts are excluded from qualifying debt, so this drives eligibility.' },
  { target: 'provenance', source: null, required: false,
    transform: { type: 'constant' as const, value: 'migrated' },
    note: 'Everything migrated is marked as such, so an adviser knows a figure was not ' +
          'confirmed in this platform.' },
];

export const MIGRATION_PROFILES: readonly MigrationProfile[] = [
  {
    key: 'generic-csv',
    name: 'Generic CSV export',
    description:
      'A starting point for any system that can produce CSV extracts of clients, cases, ' +
      'creditors and debts.',
    caveats: [
      'Column names almost certainly differ; the mapping is edited against a real extract.',
      'Historic notes and communications are frequently the hardest part of an export and ' +
      'are often supplied separately.',
      'Consent records rarely survive a CSV export intact, and consent is exactly what a ' +
      'file review will ask about. Plan for re-papering rather than assuming.',
    ],
    plan: {
      sourceSystem: 'generic-csv',
      entities: [
        { entity: 'client', targetTable: 'clients', sourceIdField: 'client_ref',
          fields: CLIENT_FIELDS },
        { entity: 'case', targetTable: 'cases', sourceIdField: 'case_ref',
          fields: [
            { target: 'reference', source: 'case_ref', required: true,
              transform: { type: 'trim' }, note: '' },
            { target: 'client_id', source: 'client_ref', required: true,
              transform: { type: 'trim' },
              note: 'Resolved through the identity map built while migrating clients.' },
            { target: 'case_type_key', source: 'product', required: true,
              transform: {
                type: 'lookup',
                table: { 'DMP': 'dmp', 'IVA': 'iva', 'DRO': 'dro', 'BKY': 'bankruptcy',
                         'PTD': 'trust-deed', 'TD': 'trust-deed', 'DAS': 'das-dpp' },
                fallback: null,
              },
              note: 'An unrecognised product code fails the record rather than guessing. ' +
                    'A case migrated as the wrong type gets the wrong rules.' },
            { target: 'case_type_version', source: null, required: true,
              transform: { type: 'constant', value: 1 }, note: '' },
            { target: 'stage', source: 'status', required: true,
              transform: {
                type: 'lookup',
                table: { 'LIVE': 'live', 'ACTIVE': 'live', 'SETUP': 'setup',
                         'ARREARS': 'arrears', 'CLOSED': 'closed', 'COMPLETE': 'closed' },
                fallback: 'live',
              }, note: '' },
            { target: 'opened_at', source: 'start_date', required: false,
              transform: { type: 'date', format: 'uk' }, note: '' },
          ]},
        { entity: 'debt', targetTable: 'debts', sourceIdField: 'debt_ref',
          fields: DEBT_FIELDS },
      ],
    },
  },
];

export function profile(key: string): MigrationProfile | undefined {
  return MIGRATION_PROFILES.find((p) => p.key === key);
}
