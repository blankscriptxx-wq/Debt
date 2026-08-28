import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { Pence } from '../money.js';

/**
 * What the client owns.
 *
 * A register rather than lines on a statement, because assets outlive any one
 * statement and because what decides a solution is the equity in a specific
 * thing: a vehicle over the DRO value limit, or a property with a charge
 * against it. Equity is derived on read rather than stored, so the value, the
 * secured debt and the equity can never drift apart.
 *
 * `exemptionClaimed` carries its reason. A vehicle needed for work or adapted
 * for a disability may be disregarded, but that is an argument someone made,
 * and a file review needs to see the argument rather than only the conclusion.
 */

export interface AssetInput {
  clientId: string;
  caseId?: string | null;
  assetType: 'property' | 'vehicle' | 'savings' | 'investment' | 'pension'
           | 'business' | 'insurance-policy' | 'valuable-item' | 'other';
  description: string;
  estimatedValuePence: Pence;
  securedDebtPence?: Pence;
  ownership?: 'sole' | 'joint' | 'beneficial' | 'none';
  ownershipShareBps?: number;
  exemptionClaimed?: string | null;
  exemptionReason?: string | null;
  valuationBasis?: 'client-estimate' | 'professional-valuation' | 'trade-guide'
                 | 'statement' | 'migrated';
  valuedOn?: string | null;
  notes?: string | null;
}

export interface Asset extends AssetInput {
  id: string;
  securedDebtPence: Pence;
  ownership: 'sole' | 'joint' | 'beneficial' | 'none';
  ownershipShareBps: number;
  /** Value less secured debt, never below zero — negative equity is not an asset. */
  equityPence: Pence;
  /** The client's share of the equity, which is what eligibility actually tests. */
  attributableEquityPence: Pence;
}

export class AssetValidationError extends Error {}

function validate(input: AssetInput): void {
  if (!input.description.trim()) {
    throw new AssetValidationError('An asset needs a description; "vehicle" alone is not one.');
  }
  if (input.estimatedValuePence < 0 || (input.securedDebtPence ?? 0) < 0) {
    throw new AssetValidationError('Values cannot be negative.');
  }
  if (input.exemptionClaimed && !input.exemptionReason?.trim()) {
    throw new AssetValidationError(
      'An exemption is an argument someone is making. Record why it applies.',
    );
  }
}

export function equityOf(asset: {
  estimatedValuePence: Pence; securedDebtPence?: Pence; ownershipShareBps?: number;
}): { equityPence: Pence; attributableEquityPence: Pence } {
  const equityPence = Math.max(0, asset.estimatedValuePence - (asset.securedDebtPence ?? 0));
  const share = asset.ownershipShareBps ?? 10_000;
  return {
    equityPence,
    attributableEquityPence: Math.round((equityPence * share) / 10_000),
  };
}

/** Total the client's share of everything not disposed of and not exempt. */
export function totalAttributableEquity(assets: readonly Asset[]): Pence {
  return assets
    .filter((a) => !a.exemptionClaimed)
    .reduce((total, a) => total + a.attributableEquityPence, 0);
}

export async function listAssets(db: Database, clientId: string): Promise<Asset[]> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT id, case_id, asset_type, description, estimated_value_pence::text,
           secured_debt_pence::text, ownership, ownership_share_bps::text,
           exemption_claimed, exemption_reason, valuation_basis, valued_on::text, notes
      FROM assets WHERE client_id = ${clientId} AND disposed_on IS NULL
     ORDER BY estimated_value_pence DESC`);
  return res.rows.map((r) => {
    const base = {
      estimatedValuePence: Number(r['estimated_value_pence']),
      securedDebtPence: Number(r['secured_debt_pence']),
      ownershipShareBps: Number(r['ownership_share_bps']),
    };
    return {
      id: r['id']!, clientId, caseId: r['case_id'] ?? null,
      assetType: r['asset_type'] as Asset['assetType'],
      description: r['description']!,
      ownership: r['ownership'] as Asset['ownership'],
      exemptionClaimed: r['exemption_claimed'] ?? null,
      exemptionReason: r['exemption_reason'] ?? null,
      valuationBasis: r['valuation_basis'] as Asset['valuationBasis'],
      valuedOn: r['valued_on'] ?? null,
      notes: r['notes'] ?? null,
      ...base,
      ...equityOf(base),
    };
  });
}

export async function recordAsset(
  db: Database, ctx: TenantContext, principal: Principal, input: AssetInput,
): Promise<string> {
  requirePermission(principal, 'client:write');
  validate(input);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO assets
      (client_id, case_id, asset_type, description, estimated_value_pence,
       secured_debt_pence, ownership, ownership_share_bps, exemption_claimed,
       exemption_reason, valuation_basis, valued_on, notes)
    VALUES (${input.clientId}, ${input.caseId ?? null}, ${input.assetType},
            ${input.description}, ${input.estimatedValuePence},
            ${input.securedDebtPence ?? 0}, ${input.ownership ?? 'sole'},
            ${input.ownershipShareBps ?? 10_000}, ${input.exemptionClaimed ?? null},
            ${input.exemptionReason ?? null}, ${input.valuationBasis ?? 'client-estimate'},
            ${input.valuedOn ?? null}, ${input.notes ?? null})
    RETURNING id`);
  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'asset.recorded',
    resourceType: 'asset',
    resourceId: id,
    reason: `${input.assetType}: ${input.description}`,
    source: 'console',
    after: { ...input, ...equityOf(input) } as Record<string, unknown>,
  });
  return id;
}

export async function updateAsset(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string, input: AssetInput,
): Promise<void> {
  requirePermission(principal, 'client:write');
  validate(input);

  const before = await db.execute(sql`SELECT * FROM assets WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE assets
       SET asset_type = ${input.assetType}, description = ${input.description},
           estimated_value_pence = ${input.estimatedValuePence},
           secured_debt_pence = ${input.securedDebtPence ?? 0},
           ownership = ${input.ownership ?? 'sole'},
           ownership_share_bps = ${input.ownershipShareBps ?? 10_000},
           exemption_claimed = ${input.exemptionClaimed ?? null},
           exemption_reason = ${input.exemptionReason ?? null},
           valuation_basis = ${input.valuationBasis ?? 'client-estimate'},
           valued_on = ${input.valuedOn ?? null}, notes = ${input.notes ?? null}
     WHERE id = ${id}`);
  const after = await db.execute(sql`SELECT * FROM assets WHERE id = ${id}`);

  await recordAudit(db, ctx, {
    action: 'asset.updated',
    resourceType: 'asset',
    resourceId: id,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: (after.rows[0] ?? null) as Record<string, unknown> | null,
  });
}
