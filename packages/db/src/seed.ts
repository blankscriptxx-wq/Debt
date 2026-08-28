/**
 * Development seed.
 *
 * Creates one firm with a working sign-in, the case types, a handful of clients
 * with genuinely different situations, and the workflow templates. The point is
 * that every screen has something real to show and the differences between
 * cases are the ones that matter operationally - a deficit budget, an overdue
 * review, a vulnerable client, a case ready to advise.
 */
import { randomUUID } from 'node:crypto';
import { sql, withPlatform, withTenant, closeDatabase, type Database } from './client.js';
import { loadDbConfig } from './config.js';
import { migrate } from './migrate.js';
import { PLANS } from './plans.js';

const FIRM_SLUG = process.env['SEED_FIRM_SLUG'] ?? 'northgate';
const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'adviser@northgate.test';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'a perfectly reasonable passphrase';

/**
 * The seed writes a known password and a known TOTP secret. Running it against
 * a deployed database would hand anyone who has read this repository a working
 * operator account, so it refuses unless the database name looks like a
 * development or test one.
 */
function assertDevelopmentDatabase(): void {
  // Read the name the connection will actually use, not the raw variable: the
  // database config supplies the same default when PGDATABASE is unset, and
  // refusing on an unset variable rejected the ordinary local case.
  const name = loadDbConfig().database;
  const looksLocal = /(_dev|_test|_local|development)$/.test(name);
  if (looksLocal || process.env['SEED_ALLOW_NON_DEV'] === '1') return;
  throw new Error(
    `Refusing to seed "${name || '(unset)'}": the name does not look like a development `
    + 'database, and the seed writes credentials that are published in this repository. '
    + 'Set SEED_ALLOW_NON_DEV=1 if you genuinely mean to.',
  );
}

async function main() {
  assertDevelopmentDatabase();
  await migrate({ silent: true });

  const { PERMISSIONS, ROLE_TEMPLATES, hashPassword, copyRoleTemplates, totpCodeAt } =
    await import('../../auth/src/index.js');
  const { CASE_TYPE_TEMPLATES } = await import('../../core/src/index.js');
  const { CAPABILITIES } = await import('../../ai/src/index.js');
  const { WORKFLOW_TEMPLATES } = await import('../../workflow/src/index.js');
  const { publishProviderCatalogue, installIntegration } =
    await import('../../integrations/src/index.js');

  const operatorPasswordHash = await hashPassword(ADMIN_PASSWORD);
  const OPERATOR_EMAIL = 'operator@solvenda.test';
  // Operators cannot sign in without a second factor, so the seed enrols one
  // and prints it. A fixed secret in development is fine and reproducible; it
  // is the absence of a secret that was dangerous, because the check used to
  // be skipped entirely when there was nothing to check.
  const OPERATOR_TOTP_SECRET = process.env['SEED_OPERATOR_TOTP_SECRET']
    ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  // Re-running the seed must be safe. Reuse the operator if one already exists,
  // rather than minting a new id and colliding on the unique email.
  const operatorId = await withPlatform(
    { operatorId: '00000000-0000-0000-0000-000000000000', reason: 'seed operator lookup' },
    async (db) => {
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id FROM platform_operators WHERE email = ${OPERATOR_EMAIL}`);
      return existing.rows[0]?.id ?? null;
    },
  ).catch(() => null) ?? randomUUID();

  // --- platform reference data ---------------------------------------------
  await withPlatform({ operatorId, reason: 'seed platform catalogues' }, async (db) => {
    await db.execute(sql`
      INSERT INTO platform_operators (id, email, full_name, password_hash,
                                      operator_role, mfa_secret)
      VALUES (${operatorId}, ${OPERATOR_EMAIL}, 'Platform Operator',
              ${operatorPasswordHash}, 'admin', ${OPERATOR_TOTP_SECRET})
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            full_name = EXCLUDED.full_name,
            mfa_secret = EXCLUDED.mfa_secret`);

    for (const p of PERMISSIONS) {
      await db.execute(sql`
        INSERT INTO permissions (key, resource, action, description, is_regulated)
        VALUES (${p.key}, ${p.resource}, ${p.action}, ${p.description}, ${p.regulated === true})
        ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description,
                                        is_regulated = EXCLUDED.is_regulated`);
    }
    for (const t of ROLE_TEMPLATES) {
      await db.execute(sql`
        INSERT INTO role_templates (key, name, description, permissions)
        VALUES (${t.key}, ${t.name}, ${t.description},
                string_to_array(${t.permissions.join(',')}, ','))
        ON CONFLICT (key) DO UPDATE SET permissions = EXCLUDED.permissions`);
    }
    for (const c of CASE_TYPE_TEMPLATES) {
      await db.execute(sql`
        INSERT INTO case_type_templates (key, name, description, category, jurisdictions, definition)
        VALUES (${c.key}, ${c.name}, ${c.description}, ${c.category},
                string_to_array(${c.jurisdictions.join(',')}, ','), ${JSON.stringify(c)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET definition = EXCLUDED.definition`);
    }
    for (const c of CAPABILITIES) {
      await db.execute(sql`
        INSERT INTO ai_capability_catalogue
          (key, name, description, category, produces_proposals,
           touches_regulated_fields, default_enabled)
        VALUES (${c.key}, ${c.name}, ${c.description}, ${c.category},
                ${c.producesProposals}, ${c.touchesRegulatedFields}, ${c.defaultEnabled})
        ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`);
    }
    await publishProviderCatalogue(db);

    for (const plan of PLANS) {
      await db.execute(sql`
        INSERT INTO plans (key, name, description, platform_fee_pence, per_seat_pence,
                           included_seats, features, usage_terms, minimum_term_months,
                           support_tier, sort_order)
        VALUES (${plan.key}, ${plan.name}, ${plan.description}, ${plan.platformFeePence},
                ${plan.perSeatPence}, ${plan.includedSeats},
                ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(plan.features)}::jsonb)),
                ${JSON.stringify(plan.usageTerms)}::jsonb, ${plan.minimumTermMonths},
                ${plan.supportTier}, ${plan.sortOrder})
        ON CONFLICT (key) DO UPDATE
          SET platform_fee_pence = EXCLUDED.platform_fee_pence,
              per_seat_pence = EXCLUDED.per_seat_pence,
              features = EXCLUDED.features`);
    }

    await db.execute(sql`
      INSERT INTO sfs_rulesets (version, source, effective_from, trigger_figures, notes)
      VALUES ('placeholder-2026', 'placeholder', '2026-04-01',
              ${JSON.stringify(PLACEHOLDER_TRIGGERS)}::jsonb,
              'Placeholder figures. Real SFS spending guidelines are licensed content a firm supplies under its own membership.')
      ON CONFLICT (version) DO NOTHING`);
  });

  // --- the firm ------------------------------------------------------------
  const tenantId = await withPlatform({ operatorId, reason: 'seed development firm' }, async (db) => {
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM tenants WHERE slug = ${FIRM_SLUG}`);
    if (existing.rows[0]) return existing.rows[0].id;
    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (slug, legal_name, trading_name, status, jurisdictions)
      VALUES (${FIRM_SLUG}, 'Northgate Debt Advice Limited', 'Northgate Debt Advice', 'active',
              ARRAY['england-wales','scotland'])
      RETURNING id`);
    return res.rows[0]!.id;
  });

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const ctx = { tenantId, actorType: 'system' as const, actorLabel: 'seed' };

  await withTenant(ctx, async (db) => {
    const roleIds = await copyRoleTemplates(db);

    const adviser = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, full_name, user_type, status, password_hash,
                         job_title, competencies)
      VALUES (${ADMIN_EMAIL}, 'Ruth Ellery', 'staff', 'active', ${passwordHash},
              'Senior Debt Adviser', ARRAY['debt-advice','qa'])
      ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id`);
    const adviserId = adviser.rows[0]!.id;

    for (const role of ['adviser', 'team-leader', 'compliance-officer', 'firm-administrator']) {
      if (roleIds[role]) {
        await db.execute(sql`
          INSERT INTO user_roles (user_id, role_id) VALUES (${adviserId}, ${roleIds[role]})
          ON CONFLICT DO NOTHING`);
      }
    }

    // One user per role, so the demo sign-in buttons show what the console
    // actually looks like to each of them. Ruth above keeps every role because
    // the seeded cases are assigned to her; these are single-role accounts and
    // the difference between them is the point.
    for (const person of DEMO_STAFF) {
      const created = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, full_name, user_type, status, password_hash,
                           job_title, competencies)
        VALUES (${person.email}, ${person.name}, 'staff', 'active', ${passwordHash},
                ${person.jobTitle},
                string_to_array(${person.competencies.join(',')}, ','))
        ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id`);
      const userId = created.rows[0]!.id;
      if (roleIds[person.role]) {
        await db.execute(sql`
          INSERT INTO user_roles (user_id, role_id) VALUES (${userId}, ${roleIds[person.role]})
          ON CONFLICT DO NOTHING`);
      }
    }

    for (const c of CASE_TYPE_TEMPLATES) {
      await db.execute(sql`
        INSERT INTO case_type_definitions (key, name, description, category, jurisdictions,
                                           version, status, template_key, definition)
        VALUES (${c.key}, ${c.name}, ${c.description}, ${c.category},
                string_to_array(${c.jurisdictions.join(',')}, ','), 1, 'active', ${c.key},
                ${JSON.stringify(c)}::jsonb)
        ON CONFLICT (tenant_id, key, version) DO UPDATE SET definition = EXCLUDED.definition`);
    }

    for (const w of WORKFLOW_TEMPLATES) {
      await db.execute(sql`
        INSERT INTO workflow_definitions (key, name, description, version, status,
                                          trigger_event, definition)
        VALUES (${w.key}, ${w.name}, ${w.description}, 1, 'active',
                ${w.triggerEvent}, ${JSON.stringify(w)}::jsonb)
        ON CONFLICT (tenant_id, key, version) DO UPDATE SET definition = EXCLUDED.definition`);
    }

    for (const c of CAPABILITIES) {
      await db.execute(sql`
        INSERT INTO ai_capabilities (capability_key, enabled)
        VALUES (${c.key}, ${c.defaultEnabled})
        ON CONFLICT (tenant_id, capability_key) DO NOTHING`);
    }

    const firmPrincipal = {
      kind: 'user' as const, tenantId, userId: adviserId,
      permissions: new Set(['integration:configure', 'case:read']),
      competencies: [], mfaSatisfied: true, status: 'active' as const,
    };
    for (const [providerKey, secrets] of [
      ['sandbox-open-banking', { clientId: 'dev', clientSecret: 'dev' }],
      ['sandbox-identity', { apiKey: 'dev' }],
      ['sandbox-e-signature', { apiKey: 'dev' }],
    ] as const) {
      await installIntegration(db, { tenantId, userId: adviserId, actorType: 'user',
                                     actorLabel: 'seed' }, firmPrincipal,
        { providerKey, secrets });
    }

    // A client with no case, existing so that integration tests have somewhere
    // safe to write. Without it the API suite created cases against whichever
    // client happened to be first in the list, which changed what the console
    // and the client portal showed and broke two other suites.
    await db.execute(sql`
      INSERT INTO clients (reference, first_name, last_name, date_of_birth, email,
                           jurisdiction, household_adults, household_children,
                           employment_status)
      VALUES ('CL-9000', 'Sandbox', 'Fixture', '1980-01-01',
              'sandbox.fixture@example.test', 'england-wales', 1, 0, 'employed')
      ON CONFLICT (tenant_id, reference) DO NOTHING`);

    // And a client with a case, for the same reason one step further on. The
    // case file suite does not read a case, it works one: it adds household
    // members, employment, assets and debts and saves a new statement. Doing
    // that to a demonstration case changes the totals the console and the
    // client portal assert on, and moves the review date the overdue-review
    // signal depends on. So it gets its own case to spoil.
    await seedCaseworkFixture(db, adviserId);

    // Portal accounts are backfilled outside the case-seeding guard above, so
    // re-running the seed against a database that already has cases still
    // creates any account the demo sign-in expects.
    for (const email of PORTAL_CLIENT_EMAILS) {
      const client = await db.execute<{ id: string; first_name: string; last_name: string }>(sql`
        SELECT id, first_name, last_name FROM clients WHERE email = ${email}`);
      const row = client.rows[0];
      if (!row) continue;
      const portalUser = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, full_name, user_type, status, password_hash)
        VALUES (${email}, ${`${row.first_name} ${row.last_name}`},
                'client', 'active', ${passwordHash})
        ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id`);
      await db.execute(sql`
        UPDATE clients SET portal_user_id = ${portalUser.rows[0]!.id} WHERE id = ${row.id}`);
      if (roleIds['client']) {
        await db.execute(sql`
          INSERT INTO user_roles (user_id, role_id)
          VALUES (${portalUser.rows[0]!.id}, ${roleIds['client']})
          ON CONFLICT DO NOTHING`);
      }
    }

    // Counts demonstration cases specifically. The casework fixture above is
    // also a case, so counting every row would make the seed think it had
    // already run and skip the demonstration data entirely.
    const alreadySeeded = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM cases
       WHERE reference <> ${CASEWORK_FIXTURE_CASE}`);
    if (Number(alreadySeeded.rows[0]!.n) > 0) {
      console.log('  cases already present, leaving them alone');
      return;
    }

    for (const [index, scenario] of SCENARIOS.entries()) {
      const client = await db.execute<{ id: string }>(sql`
        INSERT INTO clients (reference, first_name, last_name, date_of_birth, email,
                             phone_mobile, address_line1, address_city, address_postcode,
                             jurisdiction, household_adults, household_children,
                             employment_status, contact_preferences)
        VALUES (${`CL-${String(index + 1).padStart(4, '0')}`}, ${scenario.firstName},
                ${scenario.lastName}, ${scenario.dob}, ${scenario.email},
                ${scenario.phone}, ${scenario.address}, ${scenario.city}, ${scenario.postcode},
                ${scenario.jurisdiction}, ${scenario.adults}, ${scenario.children},
                ${scenario.employment}, ${JSON.stringify(scenario.preferences ?? {})}::jsonb)
        RETURNING id`);
      const clientId = client.rows[0]!.id;

      const kase = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, jurisdiction,
                           stage, status, owner_user_id, source, next_review_due, stage_entered_at)
        VALUES (${scenario.caseReference}, ${clientId}, ${scenario.caseType}, 1,
                ${scenario.jurisdiction}, ${scenario.stage}, 'open', ${adviserId},
                ${scenario.source}, ${scenario.reviewDue}, ${scenario.stageEnteredAt})
        RETURNING id`);
      const caseId = kase.rows[0]!.id;

      for (const debt of scenario.debts) {
        await db.execute(sql`
          INSERT INTO debts (case_id, client_id, creditor_name, balance_pence, arrears_pence,
                             debt_type, is_priority, provenance, account_reference)
          VALUES (${caseId}, ${clientId}, ${debt.creditor}, ${debt.balance}, ${debt.arrears ?? 0},
                  ${debt.type}, ${debt.priority ?? false}, ${debt.provenance},
                  ${debt.reference ?? null})`);
      }

      if (scenario.statement) {
        const statement = await db.execute<{ id: string }>(sql`
          INSERT INTO financial_statements (case_id, client_id, version, status, ruleset_version,
                                            total_income_pence, total_expenditure_pence,
                                            surplus_pence, total_debt_pence, completed_by,
                                            completed_at, household_composition)
          VALUES (${caseId}, ${clientId}, 1, 'current', 'placeholder-2026',
                  ${scenario.statement.income}, ${scenario.statement.expenditure},
                  ${scenario.statement.income - scenario.statement.expenditure},
                  ${scenario.debts.reduce((s, d) => s + d.balance, 0)},
                  ${adviserId}, ${scenario.statement.completedAt},
                  ${JSON.stringify({ adults: scenario.adults, children: scenario.children })}::jsonb)
          RETURNING id`);

        for (const line of scenario.statement.lines) {
          await db.execute(sql`
            INSERT INTO financial_statement_lines (statement_id, section, category, amount_pence,
                                                   entered_amount_pence, entered_frequency, source,
                                                   observed_amount_pence, observed_confidence)
            VALUES (${statement.rows[0]!.id}, ${line.section}, ${line.category}, ${line.amount},
                    ${line.amount}, 'monthly', ${line.source ?? 'declared'},
                    ${line.observed ?? null}, ${line.confidence ?? null})`);
        }

        await db.execute(sql`
          INSERT INTO affordability_assessments (case_id, statement_id, surplus_pence,
                                                 sustainable_payment_pence, contingency_pence,
                                                 rationale, assessed_by)
          VALUES (${caseId}, ${statement.rows[0]!.id},
                  ${scenario.statement.income - scenario.statement.expenditure},
                  ${scenario.sustainablePayment ??
                    Math.max(0, scenario.statement.income - scenario.statement.expenditure)},
                  0, 'Assessed at the fact find.', ${adviserId})`);
      }

      for (const consent of scenario.consents ?? []) {
        await db.execute(sql`
          INSERT INTO consents (client_id, case_id, purpose, lawful_basis, statement_version,
                                statement_text, granted, captured_via, captured_by)
          VALUES (${clientId}, ${caseId}, ${consent}, 'consent', 'v1',
                  'Recorded during onboarding.', true, 'telephone', ${adviserId})`);
      }

      if (scenario.vulnerability) {
        await db.execute(sql`
          INSERT INTO vulnerability_records (client_id, case_id, driver, indicators, severity,
                                             is_special_category, detail, support_needs,
                                             identified_by, identified_via)
          VALUES (${clientId}, ${caseId}, ${scenario.vulnerability.driver},
                  string_to_array(${scenario.vulnerability.indicators.join(',')}, ','),
                  ${scenario.vulnerability.severity}, ${scenario.vulnerability.special},
                  ${scenario.vulnerability.detail},
                  string_to_array(${scenario.vulnerability.support.join(',')}, ','),
                  ${adviserId}, 'client-disclosure')`);
      }

      for (const task of scenario.tasks ?? []) {
        await db.execute(sql`
          INSERT INTO case_tasks (case_id, client_id, title, detail, priority, assigned_to,
                                  due_at, created_via)
          VALUES (${caseId}, ${clientId}, ${task.title}, ${task.detail ?? ''}, ${task.priority},
                  ${adviserId}, ${task.dueAt}, 'user')`);
      }

      // Portal accounts for the clients the demo sign-in offers. Two rather
      // than one, because the interesting difference is between a live plan
      // with an overdue review and a Scottish case with a recorded
      // vulnerability and a deficit budget.
      if (PORTAL_CLIENT_EMAILS.includes(scenario.email)) {
        const portalUser = await db.execute<{ id: string }>(sql`
          INSERT INTO users (email, full_name, user_type, status, password_hash)
          VALUES (${scenario.email}, ${`${scenario.firstName} ${scenario.lastName}`},
                  'client', 'active', ${passwordHash})
          ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
          RETURNING id`);
        await db.execute(sql`
          UPDATE clients SET portal_user_id = ${portalUser.rows[0]!.id} WHERE id = ${clientId}`);
        if (roleIds['client']) {
          await db.execute(sql`
            INSERT INTO user_roles (user_id, role_id)
            VALUES (${portalUser.rows[0]!.id}, ${roleIds['client']})
            ON CONFLICT DO NOTHING`);
        }
      }

      for (const message of scenario.communications ?? []) {
        await db.execute(sql`
          INSERT INTO communications (case_id, client_id, channel, direction, counterparty_type,
                                      subject, body, body_redacted, status, sent_by, sent_by_type,
                                      simulated, occurred_at)
          VALUES (${caseId}, ${clientId}, ${message.channel}, ${message.direction}, 'client',
                  ${message.subject ?? null}, ${message.body}, ${message.body},
                  ${message.direction === 'outbound' ? 'sent' : 'received'},
                  ${message.direction === 'outbound' ? adviserId : null},
                  ${message.direction === 'outbound' ? 'user' : 'client'},
                  ${message.direction === 'outbound'}, ${message.at})`);
      }
    }

    console.log(`  seeded ${SCENARIOS.length} cases`);
  });

  console.log(`\nSign in at /login`);
  console.log(`  firm:     ${FIRM_SLUG}`);
  console.log(`  email:    ${ADMIN_EMAIL}`);
  console.log(`  password: ${ADMIN_PASSWORD}`);
  console.log(`\nClient portal:`);
  console.log(`  firm:     ${FIRM_SLUG}`);
  console.log(`  email:    joanne.whitfield@example.test`);
  console.log(`  password: ${ADMIN_PASSWORD}`);
  console.log(`\nSolvenda Control:`);
  console.log(`  email:    ${OPERATOR_EMAIL}`);
  console.log(`  password: ${ADMIN_PASSWORD}`);
  console.log(`  TOTP secret: ${OPERATOR_TOTP_SECRET}`);
  console.log(`  code now:    ${totpCodeAt(OPERATOR_TOTP_SECRET, Date.now())}`
              + ' (changes every 30 seconds)');
  console.log(`\nSet SOLVENDA_SIGNIN_OPERATOR_ID=${operatorId} for the sign-in lookup.`);
}



const PLACEHOLDER_TRIGGERS = {
  'food-and-housekeeping': { '1': 30_000, '2': 45_000, '3': 55_000, '4+': 65_000 },
  'communications-and-leisure': { '1': 8_000, '2': 11_000, '3': 13_000, '4+': 15_000 },
  'personal-costs': { '1': 4_000, '2': 6_500, '3': 8_000, '4+': 9_500 },
  'travel': { '1': 12_000, '2': 18_000, '3': 21_000, '4+': 24_000 },
  'other-costs': { '1': 5_000, '2': 7_000, '3': 8_500, '4+': 10_000 },
};

interface Scenario {
  firstName: string; lastName: string; dob: string; email: string; phone: string;
  address: string; city: string; postcode: string;
  jurisdiction: 'england-wales' | 'scotland'; adults: number; children: number;
  employment: string; preferences?: Record<string, unknown>;
  caseReference: string; caseType: string; stage: string; source: string;
  reviewDue: string | null; stageEnteredAt: string;
  debts: { creditor: string; balance: number; arrears?: number; type: string;
           priority?: boolean; provenance: string; reference?: string }[];
  statement?: {
    income: number; expenditure: number; completedAt: string;
    lines: { section: 'income' | 'expenditure' | 'asset'; category: string; amount: number;
             source?: string; observed?: number; confidence?: number }[];
  };
  sustainablePayment?: number;
  consents?: string[];
  vulnerability?: { driver: string; indicators: string[]; severity: string; special: boolean;
                    detail: string; support: string[] };
  tasks?: { title: string; detail?: string; priority: string; dueAt: string }[];
  communications?: { channel: string; direction: string; subject?: string; body: string; at: string }[];
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

/**
 * Demo staff, one per role.
 *
 * Every account shares the seeded password because this exists to make the
 * development sign-in buttons work; none of it is a model for real accounts.
 */
/** Clients given a portal login. Kept in step with DEMO_CLIENT_ACCOUNTS. */
const PORTAL_CLIENT_EMAILS: readonly string[] = [
  'joanne.whitfield@example.test',
  'elaine.crozier@example.test',
];

const DEMO_STAFF = [
  { email: 'leader@northgate.test', name: 'Dominic Ashworth', role: 'team-leader',
    jobTitle: 'Team Leader', competencies: ['debt-advice', 'qa'] },
  { email: 'compliance@northgate.test', name: 'Yewande Balogun', role: 'compliance-officer',
    jobTitle: 'Compliance Officer', competencies: ['qa', 'compliance'] },
  { email: 'administrator@northgate.test', name: 'Priya Chandran', role: 'firm-administrator',
    jobTitle: 'Firm Administrator', competencies: [] },
  { email: 'caseadmin@northgate.test', name: 'Tom Reilly', role: 'case-administrator',
    jobTitle: 'Case Administrator', competencies: [] },
  { email: 'ip@northgate.test', name: 'Alastair Menzies', role: 'insolvency-practitioner',
    jobTitle: 'Insolvency Practitioner', competencies: ['debt-advice', 'insolvency'] },
] as const;

/** The case the case file end-to-end suite works on, and works over. */
const CASEWORK_FIXTURE_CASE = 'DMP-9100';

/**
 * A case that exists to be worked on by the case file end-to-end suite.
 *
 * It is deliberately plain — one client, one DMP case at assessment, two
 * unsecured debts and a complete statement — because the suite's assertions are
 * about movement rather than starting values: it records what a figure is, adds
 * something, and checks the figure moved by the right amount. What it must not
 * do is move figures that other suites assert on, hence a case of its own.
 *
 * Idempotent: re-running the seed leaves an existing fixture alone, including
 * everything a previous suite run added to it.
 */
async function seedCaseworkFixture(db: Database, adviserId: string): Promise<void> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM cases WHERE reference = ${CASEWORK_FIXTURE_CASE}`);
  if (existing.rows[0]) return;

  const client = await db.execute<{ id: string }>(sql`
    INSERT INTO clients (reference, first_name, last_name, date_of_birth, email,
                         phone_mobile, address_line1, address_city, address_postcode,
                         jurisdiction, household_adults, household_children,
                         employment_status)
    VALUES ('CL-9100', 'Casework', 'Fixture', '1979-06-04',
            'casework.fixture@example.test', '07700 900910', '4 Sandal Rise',
            'Wakefield', 'WF2 7QP', 'england-wales', 1, 0, 'employed')
    ON CONFLICT (tenant_id, reference) DO UPDATE SET updated_at = now()
    RETURNING id`);
  const clientId = client.rows[0]!.id;

  const kase = await db.execute<{ id: string }>(sql`
    INSERT INTO cases (reference, client_id, case_type_key, case_type_version, jurisdiction,
                       stage, status, owner_user_id, source, next_review_due, stage_entered_at)
    VALUES (${CASEWORK_FIXTURE_CASE}, ${clientId}, 'dmp', 1, 'england-wales', 'assessment', 'open',
            ${adviserId}, 'direct', now() + interval '60 days', now() - interval '3 days')
    RETURNING id`);
  const caseId = kase.rows[0]!.id;

  for (const debt of [
    { creditor: 'Calder Bank Card', balance: 312_400, type: 'unsecured' },
    { creditor: 'Ridgeway Catalogue', balance: 87_600, type: 'unsecured' },
  ]) {
    await db.execute(sql`
      INSERT INTO debts (case_id, client_id, creditor_name, balance_pence, arrears_pence,
                         debt_type, is_priority, provenance)
      VALUES (${caseId}, ${clientId}, ${debt.creditor}, ${debt.balance}, 0,
              ${debt.type}, false, 'client-declared')`);
  }

  const statement = await db.execute<{ id: string }>(sql`
    INSERT INTO financial_statements (case_id, client_id, version, status, ruleset_version,
                                      total_income_pence, total_expenditure_pence,
                                      surplus_pence, total_debt_pence, completed_by,
                                      completed_at, household_composition)
    VALUES (${caseId}, ${clientId}, 1, 'current', 'placeholder-2026',
            198_000, 176_000, 22_000, 400_000, ${adviserId}, now() - interval '2 days',
            ${JSON.stringify({ adults: 1, children: 0 })}::jsonb)
    RETURNING id`);

  for (const line of [
    { section: 'income', category: 'wages', amount: 198_000 },
    { section: 'expenditure', category: 'rent-or-mortgage', amount: 82_000 },
    { section: 'expenditure', category: 'food-and-housekeeping', amount: 34_000 },
    { section: 'expenditure', category: 'gas-and-electricity', amount: 18_000 },
    { section: 'expenditure', category: 'council-tax', amount: 14_500 },
    { section: 'expenditure', category: 'travel', amount: 27_500 },
  ]) {
    await db.execute(sql`
      INSERT INTO financial_statement_lines (statement_id, section, category, amount_pence,
                                             entered_amount_pence, entered_frequency, source)
      VALUES (${statement.rows[0]!.id}, ${line.section}, ${line.category},
              ${line.amount}, ${line.amount}, 'monthly', 'declared')`);
  }
}

const SCENARIOS: Scenario[] = [
  {
    firstName: 'Joanne', lastName: 'Whitfield', dob: '1985-03-12',
    email: 'joanne.whitfield@example.test', phone: '07700 900123',
    address: '9 Pinfold Road', city: 'Leeds', postcode: 'LS7 3QP',
    jurisdiction: 'england-wales', adults: 1, children: 2, employment: 'employed',
    caseReference: 'DMP-0001', caseType: 'dmp', stage: 'live', source: 'website',
    reviewDue: daysAhead(-42), stageEnteredAt: daysAgo(400),
    debts: [
      { creditor: 'Halifax', balance: 412_000, type: 'unsecured', provenance: 'credit-file', reference: '****4412' },
      { creditor: 'Barclaycard', balance: 288_500, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'Very', balance: 96_400, type: 'unsecured', provenance: 'client-declared' },
      { creditor: 'Leeds City Council', balance: 74_000, arrears: 74_000, type: 'priority',
        priority: true, provenance: 'client-declared' },
    ],
    statement: {
      income: 198_000, expenditure: 176_000, completedAt: daysAgo(400),
      lines: [
        { section: 'income', category: 'earnings', amount: 168_000 },
        { section: 'income', category: 'child-benefit', amount: 30_000 },
        { section: 'expenditure', category: 'rent', amount: 85_000 },
        { section: 'expenditure', category: 'food-and-housekeeping', amount: 40_000,
          observed: 62_000, confidence: 0.86 },
        { section: 'expenditure', category: 'travel', amount: 18_000 },
        { section: 'expenditure', category: 'communications-and-leisure', amount: 12_000 },
        { section: 'expenditure', category: 'personal-costs', amount: 21_000 },
      ],
    },
    sustainablePayment: 22_000,
    consents: ['consent.processing', 'identity.verified', 'vulnerability.assessed',
               'sfs.complete', 'debts.captured', 'payment.mandate'],
    tasks: [
      { title: 'Annual review is overdue', priority: 'high', dueAt: daysAgo(14),
        detail: 'The review fell due six weeks ago.' },
    ],
    communications: [
      { channel: 'email', direction: 'outbound', subject: 'Your annual review is due',
        body: 'Hello Joanne, it is time for your annual review.', at: daysAgo(38) },
      { channel: 'sms', direction: 'outbound',
        body: 'A reminder that your review is outstanding.', at: daysAgo(24) },
      { channel: 'email', direction: 'outbound', subject: 'Annual review - second reminder',
        body: 'We have not been able to reach you.', at: daysAgo(10) },
    ],
  },
  {
    firstName: 'Marcus', lastName: 'Adeyemi', dob: '1979-11-02',
    email: 'marcus.adeyemi@example.test', phone: '07700 900456',
    address: '14 Corn Exchange Buildings', city: 'Manchester', postcode: 'M4 3TR',
    jurisdiction: 'england-wales', adults: 2, children: 0, employment: 'self-employed',
    caseReference: 'IVA-0002', caseType: 'iva', stage: 'advice', source: 'introducer',
    reviewDue: null, stageEnteredAt: daysAgo(3),
    debts: [
      { creditor: 'Lloyds Bank', balance: 1_240_000, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'MBNA', balance: 862_000, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'Zopa', balance: 540_000, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'HMRC', balance: 318_000, type: 'tax', priority: true, provenance: 'client-declared' },
      { creditor: 'Amex', balance: 214_000, type: 'unsecured', provenance: 'credit-file' },
    ],
    statement: {
      income: 312_000, expenditure: 246_000, completedAt: daysAgo(4),
      lines: [
        { section: 'income', category: 'self-employment', amount: 312_000 },
        { section: 'expenditure', category: 'mortgage', amount: 118_000 },
        { section: 'expenditure', category: 'food-and-housekeeping', amount: 44_000 },
        { section: 'expenditure', category: 'travel', amount: 32_000 },
        { section: 'expenditure', category: 'communications-and-leisure', amount: 16_000 },
        { section: 'expenditure', category: 'personal-costs', amount: 36_000 },
      ],
    },
    sustainablePayment: 60_000,
    consents: ['consent.processing', 'identity.verified', 'vulnerability.assessed',
               'sfs.complete', 'debts.captured'],
    tasks: [
      { title: 'Confirm HMRC balance before the proposal', priority: 'normal', dueAt: daysAhead(3) },
    ],
    communications: [
      { channel: 'call', direction: 'inbound',
        body: 'Fact find completed by telephone. Client explained the drop in trade.',
        at: daysAgo(4) },
    ],
  },
  {
    firstName: 'Elaine', lastName: 'Crozier', dob: '1962-06-21',
    email: 'elaine.crozier@example.test', phone: '07700 900789',
    address: '3 Bruntsfield Terrace', city: 'Edinburgh', postcode: 'EH10 4EZ',
    jurisdiction: 'scotland', adults: 1, children: 0, employment: 'not-working-health',
    preferences: { declinedChannels: ['sms'] },
    caseReference: 'DAS-0003', caseType: 'das-dpp', stage: 'fact-find', source: 'referral',
    reviewDue: null, stageEnteredAt: daysAgo(12),
    debts: [
      { creditor: 'Bank of Scotland', balance: 184_000, type: 'unsecured', provenance: 'client-declared' },
      { creditor: 'Shop Direct', balance: 62_000, type: 'unsecured', provenance: 'client-declared' },
    ],
    statement: {
      income: 118_000, expenditure: 131_000, completedAt: daysAgo(10),
      lines: [
        { section: 'income', category: 'benefits', amount: 118_000 },
        { section: 'expenditure', category: 'rent', amount: 62_000 },
        { section: 'expenditure', category: 'food-and-housekeeping', amount: 34_000 },
        { section: 'expenditure', category: 'personal-costs', amount: 21_000 },
        { section: 'expenditure', category: 'other-costs', amount: 14_000 },
      ],
    },
    sustainablePayment: 0,
    consents: ['consent.processing', 'identity.verified', 'vulnerability.assessed'],
    vulnerability: {
      driver: 'health', indicators: ['long-term-condition', 'reduced-capacity-to-work'],
      severity: 'significant', special: true,
      detail: 'Client disclosed a long-term health condition affecting her ability to work.',
      support: ['written-confirmation-of-calls', 'extra-time-for-decisions'],
    },
    tasks: [
      { title: 'Check benefit entitlement before assessing affordability', priority: 'urgent',
        dueAt: daysAhead(1),
        detail: 'The budget is in deficit; entitlement may be unclaimed.' },
    ],
    communications: [
      { channel: 'call', direction: 'inbound',
        body: 'Client called. Explained she has been unable to work since March.',
        at: daysAgo(12) },
      { channel: 'letter', direction: 'outbound', subject: 'Confirmation of our conversation',
        body: 'Written confirmation, as agreed.', at: daysAgo(11) },
    ],
  },
  {
    firstName: 'Tomasz', lastName: 'Nowak', dob: '1994-01-30',
    email: 'tomasz.nowak@example.test', phone: '07700 900222',
    address: '77 Cardiff Road', city: 'Newport', postcode: 'NP20 2EH',
    jurisdiction: 'england-wales', adults: 1, children: 0, employment: 'employed',
    caseReference: 'DRO-0004', caseType: 'dro', stage: 'fact-find', source: 'website',
    reviewDue: null, stageEnteredAt: daysAgo(2),
    debts: [
      { creditor: 'Capital One', balance: 128_000, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'Lowell Financial', balance: 96_000, type: 'unsecured', provenance: 'credit-file' },
      { creditor: 'Lowell Portfolio I Ltd', balance: 95_400, type: 'unsecured',
        provenance: 'client-declared', reference: 'possible duplicate of Lowell Financial' },
    ],
    statement: {
      income: 142_000, expenditure: 138_500, completedAt: daysAgo(2),
      lines: [
        { section: 'income', category: 'earnings', amount: 142_000 },
        { section: 'expenditure', category: 'rent', amount: 72_000 },
        { section: 'expenditure', category: 'food-and-housekeeping', amount: 28_000 },
        { section: 'expenditure', category: 'travel', amount: 14_000 },
        { section: 'expenditure', category: 'communications-and-leisure', amount: 9_500 },
        { section: 'expenditure', category: 'personal-costs', amount: 15_000 },
      ],
    },
    sustainablePayment: 3_500,
    consents: ['consent.processing', 'identity.verified', 'vulnerability.assessed',
               'sfs.complete', 'debts.captured'],
    communications: [
      { channel: 'portal', direction: 'inbound',
        body: 'Uploaded my payslips and bank statements.', at: daysAgo(2) },
    ],
  },
];

main()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exit(1);
  });
