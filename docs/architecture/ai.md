# AI architecture

The brief's constraint was explicit: *AI should assist qualified humans and
create evidence, recommendations and alerts while appropriate regulated
decisions remain properly controlled.* The design treats that as a structural
requirement rather than a prompt instruction, because a prompt instruction is
not a control.

## Four gates, in order

**1. The capability declares what it may see.**

A capability is a typed object in `packages/ai/src/capabilities/registry.ts`
declaring `permittedFields` — an allowlist of case information. The context
builder assembles only from that list. Data minimisation is a property of the
capability, not of the prompt, which means it cannot be lost by someone editing
prompt text. Free text that does make it through is scrubbed of national
insurance numbers, card numbers, sort codes, email addresses and telephone
numbers on the way out.

**2. The output must fit a declared schema.**

Each capability carries a Zod `outputSchema`, enforced at the provider through
strict tool use and validated again on return. A malformed answer is a failed
invocation, not something an adviser has to notice. There is no free-text path
from the model into the product.

**3. The output becomes a proposal, never a write.**

`producesProposals` and `touchesRegulatedFields` are declared per capability. A
proposal touching regulated substance can only be resolved by a person holding
`ai:accept_proposal`, with MFA satisfied. Resolution is recorded as accepted,
modified or rejected, with the diff between what was proposed and what was
actually written. The workflow engine obeys the same rule from the other
direction: a workflow action that would write a regulated field emits a proposal
instead of writing.

**4. Every invocation is on the record.**

An `ai_invocations` row carries who triggered it, the capability, the prompt
version, the model, the record ids the context was built from, the output, and
the human decision that followed. "Which records did the model see" has an
answer, which is the question a supervisor asks and the question a chatbot
bolted onto a CRM cannot answer.

## The house rules

Every capability inherits one instruction block. Its substance:

> You never give advice to a consumer and you never decide anything. Your output
> is read by a qualified person who is accountable for every decision on the
> case. […] Never state or imply which debt solution the client should take. You
> may set out what the information shows; the adviser decides. […] A divergence,
> an indicator or a pattern is a question to ask, not a finding.

That last line does more work than it looks like. It is the difference between
"this client is concealing income" and "declared income and observed credits
differ by £340 a month; worth asking about" — and the second is the only one a
file review can defend.

## The capabilities built

| Capability | Category | Proposals | Regulated |
|---|---|---|---|
| `case-summary` | comprehension | no | no |
| `ie-discrepancy` | analysis | yes | no |
| `advice-readiness` | analysis | no | no |
| `vulnerability-indicators` | analysis | yes | yes |
| `duplicate-debt` | analysis | yes | no |
| `advice-rationale-draft` | drafting | yes | yes |
| `communication-draft` | drafting | yes | no |
| `qa-review` | oversight | yes | no |

Eight of the roughly twenty capabilities the brief listed are implemented end to
end. The remainder — call transcription, document classification and extraction,
bank transaction categorisation, complaint-risk signalling, natural-language
search, management intelligence — are specified with their permitted fields and
output shapes but not built, and are named as such rather than counted as
delivered. Transcription in particular is gated on telephony credentials that do
not exist.

## Providers

`packages/ai/src/provider.ts` is an interface with two implementations. The
Anthropic provider targets `claude-opus-5` with adaptive thinking, strict tool
use and high output effort. The stub provider is deterministic and returns
schema-valid output derived from the input, so the entire suite runs offline and
in CI with no API key and no network. The stub is not a mock of the interface —
it implements the same contract, so every gate above is exercised by the tests
that use it.

Per-tenant enablement is configuration: a firm turns individual capabilities on
and off in Solvenda Control, and a capability that is off is off at the
invocation layer, not hidden in the UI.

## What this design gives up

It is slower than letting the model write. An adviser reviewing a proposal is a
step that a competitor without this constraint does not have, and on a good day
that step feels like friction. The argument for it is that the alternative —
automation that quietly amends a regulated field — is not a product decision but
a regulatory one, and it is not ours to make on a firm's behalf.

It also means the AI cannot fix its own mistakes. A rejected proposal is a
record of a rejected proposal; the model does not learn from it within the
platform. Feeding acceptance rates back into capability tuning is on the
roadmap and is not built.
