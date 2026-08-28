import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listHouseholdMembers } from '@/lib/console/case-file';
import {
  compositionFrom, recordHouseholdMember, removeHouseholdMember,
  HouseholdValidationError, ageOf,
} from '@solvenda/core';
import {
  Card, DataTable, EmptyState, Field, Form, Grid, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const RELATIONSHIPS = ['partner', 'child', 'parent', 'sibling', 'other-relative',
                       'friend', 'lodger', 'carer', 'other'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Who lives in the household.
 *
 * The summary bar shows the composition because that is the point of this tab:
 * household size bands the SFS trigger figures, so adding a child changes what
 * the client may spend before an explanation is required, and therefore changes
 * their surplus and which solutions are open to them.
 */
export default async function LivingTab({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { saved, error } = await searchParams;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');
  const members = await query(session, (db) => listHouseholdMembers(db, header.clientId));
  const composition = compositionFrom(members);

  async function addMember(formData: FormData) {
    'use server';
    const active = await requireSession();
    const text = (n: string) => {
      const v = String(formData.get(n) ?? '').trim();
      return v === '' ? null : v;
    };
    try {
      await query(active, (db) => recordHouseholdMember(db, active.context, active.principal, {
        clientId: header!.clientId,
        fullName: text('fullName'),
        relationship: String(formData.get('relationship') ?? 'other') as never,
        dateOfBirth: text('dateOfBirth'),
        ageYears: text('ageYears') ? Number(text('ageYears')) : null,
        isDependant: formData.get('isDependant') === 'on',
        contributesToHousehold: formData.get('contributes') === 'on',
        contributionPence: Math.round(Number(text('contribution') ?? 0) * 100),
        notes: text('notes'),
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof HouseholdValidationError
        ? cause.message : 'Could not add that person.';
      redirect(`/app/cases/${id}/living?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/living?saved=1`);
  }

  async function remove(formData: FormData) {
    'use server';
    const active = await requireSession();
    const memberId = String(formData.get('memberId') ?? '');
    const reason = String(formData.get('reason') ?? '').trim();
    try {
      await query(active, (db) =>
        removeHouseholdMember(db, active.context, active.principal, memberId, reason));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof HouseholdValidationError
        ? cause.message : 'Could not remove that person.';
      redirect(`/app/cases/${id}/living?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/living?saved=1`);
  }

  return (
    <Stack gap={5}>
      <Card title="The household"
            subtitle="Everyone living at the address, including adult children and lodgers. Composition bands the SFS trigger figures.">
        <DataTable
          rows={members}
          getKey={(m) => m.id}
          empty={<EmptyState title="Nobody else recorded."
                             detail="The client counts as one adult on their own." />}
          columns={[
            { key: 'name', header: 'Name', render: (m) => m.fullName ?? '—' },
            { key: 'rel', header: 'Relationship', render: (m) => sentence(m.relationship) },
            { key: 'age', header: 'Age', numeric: true, render: (m) => ageOf(m) ?? '—' },
            { key: 'dep', header: 'Dependant', render: (m) => (m.isDependant ? 'Yes' : 'No') },
            {
              key: 'contrib', header: 'Contributes', numeric: true,
              render: (m) => (m.contributesToHousehold
                ? `£${(m.contributionPence / 100).toFixed(2)}` : '—'),
            },
            {
              key: 'remove', header: '',
              render: (m) => (
                <form action={remove} className="sv-inline-form">
                  <input type="hidden" name="memberId" value={m.id} />
                  <input className="sv-input sv-input--sm" name="reason"
                         placeholder="Reason" aria-label="Reason for removal" required />
                  <button type="submit" className="sv-btn sv-btn--danger sv-btn--sm">
                    Remove
                  </button>
                </form>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Add someone to the household">
        <Form action={addMember} submitLabel="Add person"
              result={saved ? { ok: true, message: 'Household updated.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Name">
              <input className="sv-input" name="fullName" />
            </Field>
            <Field label="Relationship" required>
              <select className="sv-input" name="relationship" defaultValue="child">
                {RELATIONSHIPS.map((r) => <option key={r} value={r}>{sentence(r)}</option>)}
              </select>
            </Field>
            <Field label="Date of birth">
              <input className="sv-input" name="dateOfBirth" type="date" />
            </Field>
            <Field label="Age" hint="If the date of birth is not known.">
              <input className="sv-input" name="ageYears" type="number" min="0" max="129" />
            </Field>
            <Field label="Monthly contribution" hint="Leave at zero if none.">
              <input className="sv-input" name="contribution" type="number"
                     step="0.01" min="0" defaultValue="0" />
            </Field>
          </Grid>
          <label className="sv-check">
            <input type="checkbox" name="isDependant" defaultChecked />
            <span>Dependant</span>
          </label>
          <label className="sv-check">
            <input type="checkbox" name="contributes" />
            <span>Contributes to the household budget</span>
          </label>
        </Form>
      </Card>

      <SummaryBar figures={[
        { label: 'Adults', value: composition.adults, tone: 'accent',
          detail: 'Including the client' },
        { label: 'Children', value: composition.children,
          detail: composition.childAges?.length
            ? `Ages ${composition.childAges.join(', ')}` : 'Under 18' },
        { label: 'Household size', value: composition.adults + composition.children,
          detail: 'Bands the SFS trigger figures' },
      ]} />
    </Stack>
  );
}
