# Pinnacle as a second SMS provider

Date: 2026-09-14
Status: Stage 1 implemented; routing deferred (see Deferred decisions)

## Why

An adopter uses Pinnacle Teleservices rather than MSG91 for SMS. The goal is a
Pinnacle send path live on an instance quickly, with placeholder template ids,
so that everything except the DLT approvals is de-risked.

## The core finding: the two vendors are not the same shape

| | MSG91 Flow (`/api/v5/flow`) | Pinnacle JSON (`/index.php/sms/json`) |
|---|---|---|
| Auth | `authkey` header | `apikey` header |
| What you send | `template_id` + named variables | fully **rendered `text`** |
| Who renders the body | **MSG91**, from the DLT template | **nobody** |
| DLT metadata | hidden inside the flow | explicit `dltentityid`, `dlttempid`, `dltheaderid`, `dlttagid`, `tmid` |
| Sender ID | bound to the flow | explicit `sender` per request |
| `template_id` is | an MSG91-internal flow id | the **DLT template id itself** |
| Errors | HTTP status | HTTP **200** carrying `code: EC1xxx` |
| Receipts | DLR webhook | **polling only** — `/index.php/response` by `uniqueid` |

The existing wire contract `{ channel: 'sms', template_id, variables }` is
MSG91-Flow-shaped. Pinnacle cannot consume it without a rendering step, and that
is the whole design problem.

## Who renders the body

The approved body text already exists — in signalstack's
`apps/api/src/notifications/sms/sms.default.properties`, as `body=` plus
`vars=`, rendered today only into a dev-preview log. NS has no body store, and
cannot cheaply acquire one, because callers send a *raw provider id* rather than
a case id: there is no key to look a body up by.

**Decision: split by who names the template.**

| Template kind | Body source | Effect |
|---|---|---|
| **NS-named** (`login_otp`) | `ProviderDefinition.bodies`, a sibling of the `templates` map NS already owns | Keycloak login OTP and signalstack guardian OTP work with **zero caller change** |
| **Raw pass-through** (the 5 per-event cases) | the caller's new optional `body` on `/notify` | Deferred — all five ids are blank, so the path is dark |

This is what keeps signalstack off the critical path. The `body` field ships now
so the contract is stable, but nothing populates it yet.

### Consequences made load-bearing

- The comment *"keep `body` byte-identical to the DLT-approved template"* stops
  being advice. The operator matches on the text; drift is **scrubbed
  downstream**, not rejected upfront, so it fails silently.
- `renderSmsPreview`'s leniency (leaving `{{name}}` in place for a missing var)
  is correct for a log and wrong on the wire. `src/lib/providers/sms/render.ts`
  **throws** instead.

## What shipped (Stage 1)

**notification-service**

- `src/lib/providers/sms/pinnacle.ts` — the JSON endpoint, `dlttempid` taken
  from `template_id`, `sender`/`dltentityid` from env, `clientuid` = `job_id`,
  `messagetype` auto-detected (`UNI` for Devanagari — getting this wrong garbles
  rather than fails, and these deployments carry Hindi copy).
- `src/lib/providers/sms/render.ts` — `{{token}}` substitution that throws on an
  unresolved or empty variable; `TXT`/`UNI` detection and the 2000/750 ceilings.
- `SMS_PROVIDER` env switch (`msg91` default). Throws at boot on an unknown
  value rather than falling back — the wrong vendor means the wrong sender id
  and DLT entity, which is worse than not starting.
- `ProviderSendResult.retryable`. The worker retried every failure five times;
  `EC1013 invalid template` and `EC1003 insufficient balance` now dead-letter on
  the first attempt instead of being buried under "max retries reached".
- A named template with a **blank** id dead-letters with an explicit "named but
  not configured" message rather than leaking the public key through as a raw
  provider id — this is the placeholder-template case, and it has to be legible.
- `GET /metrics` Prometheus exposition, with counters in **Redis** because the
  worker is a separate process from the API that serves the scrape.
- Balance polling into `ns_provider_balance`, because `EC1003` is otherwise
  indistinguishable from a bad template id from the outside.
- Fixed `msg91.ts` logging `resp.json()` unawaited — every MSG91 failure printed
  `Promise { <pending> }`. Deleted `gupshup.ts`, a never-exported stub.

**Keycloak** — one generic `http` SMS provider in the external
`keycloak-otp-authenticator` repo, POSTing to NS `/notify`. Keycloak never
learns another vendor name; every future vendor is an NS-only change. It also
collapses today's duplicate login-OTP template id (NS
`SMS_LOGIN_OTP_TEMPLATE_ID` and Keycloak `MSG91_TEMPLATE_ID`) into one.

**automation / infra-deployments** — chart values and SOPS secrets;
`SMS_PROVIDER=pinnacle` on Test-dev-cluster only.

## Sequencing

Login OTP is the **only** SMS path with live traffic today: all five per-event
cases have blank ids and skip, and the better-auth OTP path is dead because
every cluster runs `AUTH_PROVIDER: keycloak`. So flipping a prod instance to
Pinnacle before its OTP template is approved **breaks login there**.

Therefore: ship with `SMS_PROVIDER=msg91` everywhere (zero behaviour change,
deployable immediately), and enable Pinnacle on **Test-dev-cluster** first,
where EC codes can be read without locking anyone out. Prod is a config flip
once ids land, with no code redeploy.

> **"Live with placeholder templates" does not mean SMS arrives.** Indian DLT is
> enforced at the *operator*. A blank or unregistered `dlttempid`, or an
> unregistered sender header, is rejected by Pinnacle (`EC1011`/`EC1013`/
> `EC1004`) or scrubbed downstream. Live here means deployed, exercised and
> observable with a legible error. Sender-ID/DLT-header registration is a
> separate and usually slower approval than the templates, and OTP needs it too.

## Deferred decisions

These were explicitly deferred in favour of the env switch. Recorded here so the
refactor does not have to rediscover them.

### 1. Provider routing per event or per priority

The requirement is real: *"for frequent events one provider, for smaller ones
another"* — a cost/volume decision. The env switch cannot express it.

Four candidate keys, with the recommendation first:

1. **Implied by the template binding.** Each case is configured with one
   provider binding `{provider, sender, dlt_entity_id, dlt_template_id, …}`;
   configuring a case with a Pinnacle binding *is* the routing decision. Works
   because DLT ids are per-vendor regardless — the binding must exist, so it
   carries routing for free. Falls back to a channel default when unbound.
2. **Explicit policy table**, `(network, domain, event_type) → provider`,
   most-specific-wins, separate from the binding. More expressive (move all bulk
   in one row) at the cost of keeping policy and bindings consistent.
3. **By priority class** — `realtime` → vendor A, `other` → vendor B. Matches
   #14's urgent/bulk quota isolation, but forces every template used on both
   lanes to hold DLT ids on **both** vendors, doubling the pending-ID problem.
4. **Caller names the provider.** Maximum flexibility, but puts vendor knowledge
   into every producer — the opposite of today's vendor-blind `dispatch_sms`.

### 2. Templates: structure constant, binding per provider

DLT template ids are issued by the DLT platform against the **principal entity**
(the adopter), then registered with whichever telemarketer they use. MSG91's
flow id is an MSG91-internal wrapper around that id; Pinnacle's `dlttempid` is
the id itself. So the only thing that varies by vendor is *what the template is
called when talking to that vendor*.

- **Constant:** case id, body text, declared `vars`. Event payloads and the
  variable contract never change by provider, so producers never change.
- **Per provider:** `{provider, sender_id, dlt_entity_id, dlt_template_id,
  dlt_header_id?, dlt_tag_id?}`.

In signalstack this would be a provider suffix on the existing properties,
keeping the unsuffixed key as fallback:

```
profile.create.body=…                     # shared
profile.create.vars=name,link             # shared
profile.create.template_id.msg91=
profile.create.template_id.pinnacle=
```

That does put the vendor name into signalstack config — unavoidable while
signalstack owns the id map, and exactly what deferred item 3 removes.

### 3. Move the template catalogue into NS

Producers should send a **case id**, not a DLT id. Then NS resolves body, vars
and binding in one place, the vendor suffix above disappears, and raw
pass-through ids stop existing. This is #14 Stage 1.

### 4. #14's template model has no slot for Pinnacle

Two gaps in the event-platform design (`2026-06-26-event-platform-design.md`):

- `render_mode` is two-valued (`ns_rendered` for email, `provider_ref` for
  SMS/WhatsApp) and the spec asserts *"SMS bodies are DLT-registered at MSG91 …
  the provider renders"*. Pinnacle is a **third mode**: NS renders, but the body
  is DLT-registered and an id must ride along. Call it `dlt_local_render`.
- `provider` is an attribute of `template`, not part of its key
  `(network, channel, template_key, locale)` — which assumes one vendor per
  `(network, channel)`. That assumption does not survive deferred item 1.

### 5. Receipts asymmetry

#14's receipt design assumes provider callbacks (SES/SNS, MSG91 DLR, Twilio
status). **Pinnacle documents no DLR webhook** — only polling
`/index.php/response` by `uniqueid`. Stage 2.5 needs a polling lane or a vendor
conversation. The adapter already returns `uniqueid` as `provider_message_id`,
so the correlation key exists.

## Open verification items

- The vendor doc says `message` must be URL-encoded. That is stated for the
  form-encoded endpoint and is ambiguous for JSON; one live test settles it. The
  adapter currently sends plain JSON strings.
- The doc lists the status endpoint as `http://`. The adapter forces `https:`.
- Error response *shape* for the JSON endpoint is not documented — only the code
  list. `readResponse` reads `code`/`status` defensively and treats anything
  non-success as an error; worth confirming against a real rejection.
