# Communications

## Why this exists

An adviser spends more of their day in conversation than in any other part of a
case. Every incumbent in this market models that as a *log*: a table of things
that were said, bolted to the side of the case. The consequence is that
receiving a client's bank statement — the single most common piece of work in
debt advice — means downloading a file from one system and uploading it to
another, classifying it by hand, and hoping somebody remembers to record where
it came from.

This is built the other way round. Communications is part of case management, so
an adviser can hold a conversation, receive evidence, file it, advance the case
and understand the client without leaving the thread.

**The connection that makes it more than an inbox** is that the case file
already resolves precisely what evidence each case is missing
(`packages/core/src/evidence/state.ts`). So a document arriving on WhatsApp is
not filed into a folder — it is offered against the requirement the case is
actually waiting on, and accepting the suggestion moves the case's evidence
state in front of the adviser. Nothing else in this market can do that, because
nothing else has an evidence model to connect it to.

---

## 1. What is technically possible

Inbound and outbound text, images, documents, video, audio and voice notes;
delivery and read receipts; approved message templates; interactive buttons and
lists; per-number webhooks. Everything the brief asked for is available on the
official platform.

## 2. Restrictions we design around

> Meta's own developer domain is blocked by this environment's egress proxy, so
> the rules below were corroborated from business solution provider documentation
> and several independent sources rather than read first-hand. **Re-verify every
> figure against Meta's documentation before go-live.** The architecture is
> arranged so that none of them is load-bearing: each is a value in one place.

| Restriction | What it forces |
|---|---|
| **Debt collection is a prohibited category**, "irrespective of the global or local licenses, registrations, or other approvals your business may hold" | See §11. The largest risk in this work. |
| **Media ids in webhooks expire after ~7 days**; download URLs last ~5 minutes | Attachments are ingested on receipt. This one fact determines the whole attachment architecture. |
| 24-hour customer service window; outside it only approved templates | A visible state in the composer, not an error discovered on send. |
| Opt-in required before a business initiates | Modelled on the existing `consents` table; `channel_accounts.opt_in_consent_purpose` says which purpose satisfies it. |
| Template approval belongs to Meta, per category | `communication_templates.provider_status` is a cache of theirs, never the source of truth. |
| ~100MB documents, 16MB video/audio, 5MB images | `sizeLimitFor()` in the adapter; inbound failures surface on the attachment. |
| From **1 October 2026**, free-form replies inside the service window become billable | A cost-per-conversation line in the commercial model, not a code change. |

## 3. Recommended architecture

One inbox over every channel. WhatsApp is the first live channel, not the
design centre — `communications` has been channel-agnostic since migration 0013,
and conversations, matching, attachments and the inbox are all written against
the channel rather than against WhatsApp.

That is not architectural neatness. It is the mitigation for §11: a firm that
cannot get WhatsApp approval still gets the whole product over SMS, email and
the client portal.

```
provider ──► /api/webhooks/whatsapp
                │  verify signature (HMAC-SHA256, constant time)
                │  resolve tenant from the RECEIVING number, in platform context
                ▼
             receiveInbound()  ──► conversation (open or reuse)
                │                  communication row
                │                  message_attachments (pending)
                ▼
             ingestAttachment()  fetch ▸ checksum ▸ scan ▸ store
                                 └─► document, status 'unfiled'
                ▼
             inbox  ──►  suggestion  ──►  fileAttachment()
                                          └─► document 'active'
                                          └─► verification item verified
                                          └─► the spine moves
```

## 4. Provider strategy

The choice of business solution provider affects price, onboarding and developer
experience but **not capability** — templates, categories, rate limits and
quality ratings are set by Meta and reach every provider identically. So the
provider is a swappable adapter (`packages/integrations/src/whatsapp.ts`), and
choosing one is configuration.

When a firm goes live: **360dialog** for EU hosting, a flat per-number fee and an
ISV partner API; **Twilio** where a firm already runs on it; the **Cloud API
directly** only if we later want to remove a dependency and are willing to own
number registration and template submission ourselves.

## 5. Multi-tenant onboarding

**Tech Provider model.** Each firm connects its own WhatsApp Business Account
through embedded signup and is billed by Meta directly. Their compliance, their
approval, their number. We do not become a reseller of messaging, and one firm's
policy breach cannot take down every other firm's channel.

`channel_accounts` holds one row per number or address, with the provider's
phone number id, a queue, business hours and out-of-office text. A firm with one
number and a firm with one per department are the same shape.

## 6. The shared inbox

Three panes: **what is waiting**, **what was said**, **who this is**.

- **Assignment.** `assigned_to` with unassigned as a legitimate state — that is
  what the shared queue is made of. Transfer is assignment to somebody else, and
  both are audited.
- **Unread is per conversation, not per adviser.** In a shared inbox, per-person
  unread counts tell nobody whether the *client* has been answered, which is the
  only question the client cares about.
- **Replying clears what is owed; an internal note does not.** Writing to a
  colleague is not answering the client, and a queue that thinks otherwise
  quietly loses people.
- **Internal notes are a different shape, not a different shade** — hatched
  background, dashed border, an explicit label. The one thing that must never
  happen is a note meant for a colleague being read as something the client saw.
- **The service window is a state.** Outside it the composer says so before the
  adviser types, rather than reporting a failure after they have written a reply.

## 6a. Letters and signatures

Most of what a firm sends is not written from scratch — an appointment
confirmation, a request for a payslip, a reminder that a review is due — so the
composer offers the firm's letters alongside free text. On WhatsApp this is not
a convenience: once the 24-hour window has closed, an approved template is the
only thing the platform will carry, so the picker is the only way to reach
somebody.

**Every message a person sends carries that person's name, and the name is read
from the users table by the authenticated user id.** There is no parameter for
it (`packages/comms/src/signature.ts`). An adviser cannot sign as a colleague, a
compromised session cannot sign as somebody senior, and a workflow or an AI
capability is signed as the firm and marked *(automated message)* — it is never
given a person's name, because a client acting on what they think an adviser
told them, when no adviser said it, is the regulated-permission failure arriving
by a different route. An account with no name recorded cannot send to a client
at all; that is refused rather than defaulted.

The signature takes two shapes, and WhatsApp forces the distinction:

| | How it is signed |
|---|---|
| Free text | Appended. There is no approved form to match. |
| A template | Filled into a `{{adviser}}` **variable**. An approved template's body is fixed by Meta, so appending would produce a message that no longer matches what was approved. |

Which is why a template that does not declare `{{adviser}}` cannot be activated
(`activateTemplate`) — it is not a message missing a line, it is a message that
can never be attributed to anybody, and the moment to catch that is before a
firm builds a process on it. `renderTemplate` applies the signature *last*, so a
caller passing `adviser` among the variables does not get to choose who the
message is from.

The picker shows every template, including ones that cannot be sent, with the
reason: an adviser needs to know the letter exists and is waiting on the
provider. Seeded templates are utility and service only — appointments,
document requests, acknowledgements, review reminders. **None gives advice**: a
recommendation is a regulated decision with its own screen, its own permission
and its own immutable record, and it does not belong in something sent at the
press of a button. None asks anybody for money either (§11).

## 7. Client and case matching

Three rules, and the third is the one that protects clients from each other.

1. A **verified `channel_identity`** is a match.
2. The identifier appearing on a client record is a **candidate, never a match**.
   Household phones are shared and mobile numbers are recycled.
3. Everything else goes to the **unidentified queue**, where a person decides.
   Confirming creates the verified identity, so the same number is automatic
   ever after — which is what makes rule 2 affordable.

Numbers are normalised to E.164 on write and compared on their last ten digits,
so a record saying "07700 900123" matches a message arriving as
"+447700900123".

**The tenant is fixed by the receiving `channel_account`, never by the sender.**
Two firms can hold the same client's number; routing on the recipient makes
cross-tenant leakage structurally impossible rather than a filter somebody has
to remember. Tested in `packages/comms/test/conversations.test.ts`.

## 8. Attachments

Ingested on receipt, never on demand, because the media id expires. The sequence
is fetch ▸ compare the provider's checksum ▸ malware scan ▸ store ▸ create a
document with status `unfiled`. A missing scanner **fails closed**: no verdict
means no document.

An attachment therefore exists in the interface before anybody asks for it, and
the adviser is never waiting on a download.

## 9. Save to Case

The file never touches the adviser's machine. Both ends are server-side, so a
drag moves a *reference* and the server does the copy — which is the only reason
this works at all with a 90MB statement.

1. A suggestion, weighted by what this case is missing: *"Looks like a creditor
   letter, and this case is waiting on debts and creditors captured."*
2. **Confirm**, **change the destination**, or **not for the file** — a client
   sending a photo of their dog should not require an adviser to invent a
   document type for it.
3. Confirming records provenance (`source_communication_id`, `source_channel`),
   writes the audit entry, and moves the verification requirement so the spine
   changes on screen.
4. Confidence is shown. A classifier that always sounds certain teaches people
   to stop reading it.
5. **Accepting a suggestion and choosing a classification are recorded
   differently** (`classified_by`, `classification_accepted_by`). "It guessed and
   nobody looked" must stay distinguishable from "somebody read it and agreed".
6. A keyboard-reachable control is always present. Drag-and-drop alone fails for
   keyboard, screen-reader and touch users, and this is the daily job.

## 10. AI

Every suggestion goes through the existing capability registry and proposal gate
(`packages/ai`), so it is proposed to a person who accepts, modifies or rejects
it, and the regulated-permission rule already refuses AI principals outright.

Built: document classification and destination. Designed and not yet built:
conversation summary, suggested reply (draft only, never auto-sent), intent and
urgency, complaint detection, translation. `vulnerability-indicators` already
exists and should be applied to inbound conversation text — see §11.

## 11. Security and compliance

**The policy risk.** Meta prohibits debt collection outright, whatever licences a
firm holds. Solvenda's users advise debtors rather than collect for creditors,
and the use case here is collecting documents and holding service conversations
— materially different, and defensible. But enforcement is blunt and a WABA ban
has no reliable appeal, so: the firm owns the account and makes its own
representation, onboarding must show the policy and record their confirmation,
we ship no collection-style templates, and **we never warrant approval**. The
omnichannel architecture is the fallback if a firm cannot get it.

**Special-category data.** A client in financial difficulty will disclose health
information over WhatsApp, unprompted, because it is why they are in difficulty.
That is Article 9 data arriving in a chat log. Inbound text is now read for
FG21/1 signals on delivery and surfaced as a proposal — see §11a.

**The rest.** Webhook signatures verified in constant time; a missing secret
refuses everything rather than accepting everything; unknown numbers get
`accepted: false` rather than a message confirming which numbers exist; media
quarantined until scanned; retention through the existing `retention_class` /
`delete_after` / `legal_hold`; tenant isolation by row-level security under a
role that cannot bypass it.

## 11a. Vulnerability from what a client writes

Every inbound message from an identified client is read for FG21/1 signals
(`packages/comms/src/vulnerability-scan.ts`), and what it finds becomes a
proposal a named person decides. Nothing about it is a shortcut: the AI
principal is not granted `vulnerability:write`, and the authorisation engine
refuses automation any regulated permission, so there is no code path from a
signal to a record that does not pass through somebody.

It runs in `after()` rather than inline. The provider redelivers a webhook that
does not answer promptly and `receiveInbound` inserts unconditionally, so a slow
model call on the delivery path would produce duplicate messages as well as a
slow reply. Attachments stay before the response, because their bytes expire in
minutes and an assessment does not.

Three refusals are the design:

- **An unidentified conversation is not assessed at all.** The person may not be
  a client, and a permanent record of a possible health disclosure attached to
  nobody is worse than not looking.
- **A firm that has not opted in accumulates nothing** — no invocation, no audit
  row, not even a note that scanning was considered. The capability ships
  disabled and a firm turns it on deliberately.
- **Health information cannot be recorded without a consent naming an Article 9
  condition** (`packages/core/src/case-file/vulnerability.ts`). Migration 0009
  claimed this was enforced in `@solvenda/core` and it never was. It is now, with
  the database holding the column-level half underneath, and it refuses with the
  reason named — no consent, no condition, withdrawn, expired, wrong client,
  refused — because "consent required" is not something an adviser can act on.

`is_special_category` is derived from the driver rather than accepted from the
caller: knowing someone's difficulty is driven by their health *is* information
about their health, so it cannot be declared away. The consent is checked
**before** the proposal is decided, because a decision is immutable once made and
the audit ledger is hash-chained — deciding first and failing after would strand
a suggestion that could never be applied or re-decided.

Internal notes are excluded from what the model sees. An adviser's note to a
colleague is not the client speaking, and a model given it would quote the firm
back at itself. Everything else is scrubbed by the existing allowlist and
redaction path before it leaves.

A model's confidence never becomes the firm's assertion: `weak` and `moderate`
map to `possible`, `strong` to `present`, and **nothing maps to `significant`** —
under FG21/1 that is a judgement that the firm must change how it deals with this
person, which no model reading a chat log is in a position to make.

## 12. Data model

Migration `0024_vulnerability_signals.sql`: `vulnerability_records.source_communication_id`;
`'none'` admitted as a driver and severity so an assessment that found nothing is
recordable, with a coherence check and one live "none" per client;
`CHECK (is_special_category = false OR consent_id IS NOT NULL) NOT VALID`, which
enforces on every write while grandfathering rows written before the gate existed;
`ai_proposals.client_id`, because vulnerability belongs to a person and the
inbound path resolves a case only when the client has exactly one open.

Migration `0023_conversations.sql`: `channel_accounts`, `channel_identities`,
`conversations`, `message_attachments`; `communications.conversation_id`;
`documents.source_communication_id`, `source_channel`,
`classification_accepted_by/_at`; document statuses `quarantined` and `unfiled`;
template provider status, category and language.

## 13. UI

`/app/inbox` — list, conversation, context. Below 1280px the three columns stack
rather than compressing. Unread is weight rather than a coloured dot, so it
survives being printed, being colour-blind and being glanced at from a metre.

## 14. Automation events

`comms.message.received`, `comms.conversation.linked` (security severity — it is
where a mis-identification would be introduced), `comms.conversation.assigned`,
`comms.attachment.filed`, `comms.attachment.quarantined`,
`comms.template.activated`, and `vulnerability.recorded` / `.updated` (regulated,
and until this work never emitted by anything). A sent template records which template and version,
who signed it and whether a person did (`signedBy`, `humanSigned`). These feed the existing
workflow engine and webhook delivery.

## 15. Future channels

The tables carry email, SMS, call and portal already; only the WhatsApp adapter
is built. Email ingestion needs a mailbox adapter and threading on
`References`/`In-Reply-To`. Telephony needs recording and transcription, which is
the one workload wanting a long-lived worker rather than a serverless function.

## 16. What competitors do better

They have live integrations and we have simulators. That is the honest
difference and it is not a small one. Aryza publicly markets WhatsApp for
collections; several vendors have working email ingestion and telephony we do
not.

## 17. What puts this ahead

**Receiving evidence advances the case.** Everywhere else, filing a document is
filing a document. Here it moves a named requirement and the adviser watches the
case get closer to ready. That is only possible because the evidence model exists
underneath it.

Alongside that: an inbox rather than a log; matching that refuses to guess;
attachments that cannot be lost to an expiring media id; and a record that
distinguishes what the software suggested from what a person decided.
