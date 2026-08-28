import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, loadClient } from '@/lib/console/case-file';
import {
  updateClientDetails, ageAt, ClientValidationError,
  CONTACT_CHANNELS, type ContactChannel,
} from '@solvenda/core';
import { Card, Field, Form, Grid, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr', 'Prof', 'Rev'];
const MARITAL = ['single', 'married', 'civil-partnership', 'cohabiting',
                 'separated', 'divorced', 'widowed'];
const OCCUPANCY = ['owner-occupier', 'mortgaged', 'private-tenant', 'social-tenant',
                   'living-with-family', 'lodger', 'supported-housing',
                   'temporary-accommodation', 'no-fixed-abode', 'other'];
const EMPLOYMENT = ['employed', 'self-employed', 'unemployed', 'retired', 'student',
                    'carer', 'unable-to-work', 'homemaker', 'other'];

const CHANNEL_LABELS: Record<ContactChannel, string> = {
  'home-phone': 'Home phone', mobile: 'Mobile', 'work-phone': 'Work phone',
  email: 'Email', sms: 'SMS', post: 'Post',
};

function sentence(value: string): string {
  return value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export default async function ClientDetailsTab({
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
  const client = await query(session, (db) => loadClient(db, header.clientId));
  if (!client) redirect('/app/cases');

  const permissions = (client['contact_preferences'] ?? {}) as {
    service?: string[]; marketing?: string[];
    bestTimeToCall?: string; preferredMethod?: string;
  };
  const age = ageAt(client['date_of_birth'] as string | null);

  async function save(formData: FormData) {
    'use server';
    const active = await requireSession();
    const value = (name: string) => {
      const v = String(formData.get(name) ?? '').trim();
      return v === '' ? null : v;
    };
    const channels = (prefix: string) =>
      CONTACT_CHANNELS.filter((c) => formData.get(`${prefix}:${c}`) === 'on');

    try {
      await query(active, (db) => updateClientDetails(db, active.context, active.principal,
        header!.clientId, {
          title: value('title'),
          firstName: String(formData.get('firstName') ?? ''),
          middleNames: value('middleNames'),
          lastName: String(formData.get('lastName') ?? ''),
          previousNames: String(formData.get('previousNames') ?? '')
            .split(',').map((n) => n.trim()).filter(Boolean),
          dateOfBirth: value('dateOfBirth'),
          placeOfBirth: value('placeOfBirth'),
          maritalStatus: value('maritalStatus'),
          gender: value('gender'),
          nationalInsuranceNumber: value('nino'),
          email: value('email'),
          phoneMobile: value('phoneMobile'),
          phoneOther: value('phoneOther'),
          addressLine1: value('addressLine1'),
          addressCity: value('addressCity'),
          addressPostcode: value('addressPostcode'),
          occupancyStatus: value('occupancyStatus'),
          employmentStatus: value('employmentStatus'),
          securityQuestion: value('securityQuestion'),
          securityAnswer: value('securityAnswer'),
          contactPermissions: {
            service: channels('service'),
            marketing: channels('marketing'),
            bestTimeToCall: value('bestTimeToCall'),
            preferredMethod: value('preferredMethod') as ContactChannel | null,
          },
        }));
    } catch (cause) {
      const message = cause instanceof ClientValidationError
        ? cause.message
        : 'Could not save. Nothing was changed.';
      redirect(`/app/cases/${id}/client?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/client?saved=1`);
  }

  return (
    <Form action={save} submitLabel="Save client details"
          result={saved ? { ok: true, message: 'Client details saved.' }
                : error ? { ok: false, message: error } : null}>
      <Stack gap={5}>
        <Card title="Name and identity">
          <Grid min="220px">
            <Field label="Title">
              <select className="sv-input" name="title" defaultValue={client['title'] ?? ''}>
                <option value="">—</option>
                {TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="First name(s)" required>
              <input className="sv-input" name="firstName" required
                     defaultValue={client['first_name'] ?? ''} />
            </Field>
            <Field label="Middle name(s)">
              <input className="sv-input" name="middleNames"
                     defaultValue={client['middle_names'] ?? ''} />
            </Field>
            <Field label="Last name" required>
              <input className="sv-input" name="lastName" required
                     defaultValue={client['last_name'] ?? ''} />
            </Field>
            <Field label="Other or previous names"
                   hint="Comma separated. Needed for a credit search to return everything.">
              <input className="sv-input" name="previousNames"
                     defaultValue={(client.previous_names ?? []).join(', ')} />
            </Field>
            <Field label="Date of birth"
                   hint={age == null ? 'Drives eligibility age tests' : `Age ${age}`}>
              <input className="sv-input" name="dateOfBirth" type="date"
                     defaultValue={client['date_of_birth'] ?? ''} />
            </Field>
            <Field label="Place of birth">
              <input className="sv-input" name="placeOfBirth"
                     defaultValue={client['place_of_birth'] ?? ''} />
            </Field>
            <Field label="National insurance number">
              <input className="sv-input" name="nino"
                     defaultValue={client['national_insurance_number'] ?? ''} />
            </Field>
            <Field label="Marital status">
              <select className="sv-input" name="maritalStatus"
                      defaultValue={client['marital_status'] ?? ''}>
                <option value="">—</option>
                {MARITAL.map((m) => <option key={m} value={m}>{sentence(m)}</option>)}
              </select>
            </Field>
            <Field label="Gender"
                   hint="Free text. Nothing is computed from it.">
              <input className="sv-input" name="gender" defaultValue={client['gender'] ?? ''} />
            </Field>
            <Field label="Employment status">
              <select className="sv-input" name="employmentStatus"
                      defaultValue={client['employment_status'] ?? ''}>
                <option value="">—</option>
                {EMPLOYMENT.map((e) => <option key={e} value={e}>{sentence(e)}</option>)}
              </select>
            </Field>
            <Field label="Occupancy status">
              <select className="sv-input" name="occupancyStatus"
                      defaultValue={client['occupancy_status'] ?? ''}>
                <option value="">—</option>
                {OCCUPANCY.map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
              </select>
            </Field>
          </Grid>
        </Card>

        <Card title="Contact">
          <Grid min="240px">
            <Field label="Mobile">
              <input className="sv-input" name="phoneMobile"
                     defaultValue={client['phone_mobile'] ?? ''} />
            </Field>
            <Field label="Other phone">
              <input className="sv-input" name="phoneOther"
                     defaultValue={client['phone_other'] ?? ''} />
            </Field>
            <Field label="Email">
              <input className="sv-input" name="email" type="email"
                     defaultValue={client['email'] ?? ''} />
            </Field>
            <Field label="Address">
              <input className="sv-input" name="addressLine1"
                     defaultValue={client['address_line1'] ?? ''} />
            </Field>
            <Field label="Town or city">
              <input className="sv-input" name="addressCity"
                     defaultValue={client['address_city'] ?? ''} />
            </Field>
            <Field label="Postcode">
              <input className="sv-input" name="addressPostcode"
                     defaultValue={client['address_postcode'] ?? ''} />
            </Field>
            <Field label="Best time to call">
              <input className="sv-input" name="bestTimeToCall"
                     defaultValue={permissions.bestTimeToCall ?? ''} />
            </Field>
            <Field label="Preferred method"
                   hint="Must be a channel permitted for service contact.">
              <select className="sv-input" name="preferredMethod"
                      defaultValue={permissions.preferredMethod ?? ''}>
                <option value="">—</option>
                {CONTACT_CHANNELS.map((c) =>
                  <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
              </select>
            </Field>
          </Grid>
        </Card>

        <Card
          title="Permission to contact"
          subtitle="Service and marketing are separate legal bases. Withdrawing marketing consent does not affect the firm's ability to service the case, so they are recorded apart."
        >
          <Grid min="280px">
            <div>
              <h4 className="sv-subheading">Service</h4>
              {CONTACT_CHANNELS.map((c) => (
                <label key={c} className="sv-check">
                  <input type="checkbox" name={`service:${c}`}
                         defaultChecked={permissions.service?.includes(c)} />
                  <span>{CHANNEL_LABELS[c]}</span>
                </label>
              ))}
            </div>
            <div>
              <h4 className="sv-subheading">Marketing</h4>
              {CONTACT_CHANNELS.map((c) => (
                <label key={c} className="sv-check">
                  <input type="checkbox" name={`marketing:${c}`}
                         defaultChecked={permissions.marketing?.includes(c)} />
                  <span>{CHANNEL_LABELS[c]}</span>
                </label>
              ))}
            </div>
          </Grid>
        </Card>

        <Card
          title="Telephone security"
          subtitle="Used to identify the client when they call. The answer is stored hashed, like a password, and cannot be read back."
        >
          <Grid min="280px">
            <Field label="Security question">
              <input className="sv-input" name="securityQuestion"
                     defaultValue={client['security_question'] ?? ''} />
            </Field>
            <Field label="Answer"
                   hint={client['has_security_answer']
                     ? 'An answer is set. Leave blank to keep it.'
                     : 'No answer set yet.'}>
              <input className="sv-input" name="securityAnswer" type="password"
                     autoComplete="off" />
            </Field>
          </Grid>
        </Card>
      </Stack>
    </Form>
  );
}
