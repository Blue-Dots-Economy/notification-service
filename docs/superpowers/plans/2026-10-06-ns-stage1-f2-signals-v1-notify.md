# NS Stage 1 Plan F2 — Signals Sends Events to `/v1/notify`; Copy Moves to NS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every notification Signals sends becomes an *event* (`event_type` + recipient `domain` + data variables), posted to notification-service `POST /v1/notify` with Signals' Keycloak service token. Signals stops rendering email. Its current copy and HTML shells become per-network NS catalogues, generated once and committed to bluedots-schemas.

**Architecture:**
- **Event mapping.** Each Signals send site maps to one event type. The recipient's network *domain id* (e.g. `seeker`, `service_provider`, `student`) goes in `domain`. The NS routing policies hold today's channel and copy-grouping rules: role mapping, and apply/shortlist/pre_shortlist → "apply" copy.
- **Same request shape for the future event processor.** The future event processor (Stage 3/4) will post exactly the same body, so the API does not change later.
- **Catalogue generator.** A generator in signals-dpg reuses today's shell and substitution code. It passes `{{token}}` strings through, so each generated template renders, in NS, byte-identical to what Signals renders today. A golden test proves this per case.
- **Generated output.** The generator writes one `ns-catalogue.json` per bluedots-schemas network/brand directory.
- **No HMAC client.** The Signals NS client is rewritten for `/v1/notify` with a bearer token from a shared client-credentials token source. The HMAC client is deleted.

**Tech Stack:**
- signals-dpg: pnpm monorepo, TypeScript, Fastify, vitest.
- bluedots-schemas: JSON only.
- Target API: notification-service `/v1/notify` (Plans C2, D, F1).

**Tasks:** Task 0 is notification-service (F2-8); Tasks 1, 2, 4, 5, 6 are signals-dpg; Task 3 is bluedots-schemas.

**Spec:** notification-service `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04), §Stages item 9. Issue: Blue-Dots-Economy/signals-dpg#496.

**Plan F context:**
- F1, the NS catalogue seed and export, is PR #155.
- F2 is this plan.
- F3 moves the Keycloak OTP plugin to `/v1/notify`.
- F4 covers the e2e harness, the chart (mount the catalogue, Signals bearer env) and NS legacy `/notify` removal.

All four ship as one release. Nothing in F2 is deployed until F4 wires it.

## Global Constraints

- **Events, not templates.**
  - Signals sends `event_type` + `domain` + `to` + `variables` (+ `priority`, `idempotency_key`, `correlation_id`, and for support `cc`/`reply_to`/`attachments`).
  - Signals never sends `template_key`, `channel`, HTML, subjects or vendor ids.
  - The only exception is outside Signals: Keycloak login OTP (F3), which uses `template_key`.
- **`domain` is the recipient's network domain id**, exactly as in network.json. It is `null` for events with no recipient domain: guardian OTP, support, and welcome without a known signup domain.
- **Copy lives in NS.** After this plan, Signals holds no email copy, shells or brand colours at runtime. The generator and its inputs live under `tools/ns-catalogue/` and are run by hand. Their output is committed to bluedots-schemas.
- **Byte-faithful.** For every case, the generated template rendered with NS's rules must equal the HTML and subject Signals renders today for the same inputs. The exceptions are only the rulings below, F2-2 and F2-3.
- **OTP stays in Signals.** Signals still generates, stores (sha256 in Redis) and verifies guardian OTPs. NS only carries them.
- **Priorities.** Guardian OTP, `otp.generic` and welcome are `urgent`. Everything else is `normal`.
- **Auth.** Signals sends `Authorization: Bearer <token>` from a `client_credentials` token for `KEYCLOAK_API_CLIENT_ID` (`signals-api`). The token is cached until 30 s before expiry and refreshed once on a 401. HMAC is removed.
- **Unchanged failure semantics.** Critical sends (guardian, otp.generic, support) still throw. Best-effort sends still log and continue. A `422` from NS is a configuration or caller error: it is logged with the NS `error` code and never retried.
- **Standing rules.**
  - Public repos: state rules positively.
  - Never log OTPs, variable values or recipients beyond what Signals logs today.
  - Never run `vitest --root /`.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches.**
  - signals-dpg: `feat/ns-v1-notify` off `feature`.
  - bluedots-schemas: `feat/ns-catalogues` off its integration branch.
  - Read each repo's CLAUDE.md first.
  - Nothing is pushed without approval.

### Event table (the contract; F4's e2e and the generated policies both follow it)

| Event type | `domain` | Variables Signals sends | Policy → templates (per recipient role) |
|---|---|---|---|
| `action.<actionType>.<shape>` — actionType from network.json (`connect`, `apply`, `shortlist`, …), shape ∈ `inbound_request`, `outbound_request`, `inbound_status`, `outbound_status` | recipient's item domain | `name`, `ctaUrl` | email → `action.<connect\|apply>.<seeker\|provider>.<shape>` |
| `action.cancelled_by_retire` | recipient's item domain | `ctaUrl` | email → `retire.cancel` |
| `item.created`, `item.created_draft`, `item.updated`, `item.paused`, `item.retired` | item domain | `name`, `ctaUrl` | email → `<profile\|offer>.<create\|create_incomplete\|update\|pause\|retire>` |
| `item.onboarded_by_aggregator` | item domain | `aggregatorOrg`, `networkName`, `ctaUrl` | email → `account.aggregator_init.<seeker\|provider>` |
| `user.welcome` | signup domain, or `null` | `userName`, `appName`, `teamName`, `siteUrl`, `1` (the WhatsApp content variable: the recipient's name) | mode `all`: email → `welcome.<role>` (null domain → `welcome`); whatsapp → `welcome` |
| `guardian.otp.account`, `.profile`, `.action`, `.action_bulk` | `null` | `message` (the OTP), `parentName`, `domain`, `org`, `teamName` (+ bulk: `noun`, `orgList`) | `first_available`: email → `guardian.<kind>`; sms → `login_otp` |
| `guardian.otp.generic` | `null` | `message` (the OTP) | `first_available`: email → `otp.generic`; sms → `login_otp` |
| `support.request` | `null` | `reference`, `type`, `name`, `fromSite`, `details`, `teamName`, `phone`, `email`, `submittedAt`, `attachmentsSummary` | email → `support.request` |

Notes on the table:
- **Template keys** are today's Signals case ids. A template's `name` variable is required only where its copy uses it.
- **Channel choice.** Signals supplies only the contact point the recipient has. NS's `planDelivery` drops channels without one. For example, guardian OTP with a phone uses SMS.
- **Role mapping.** The generator emits one policy per (domain id in network.json, event). It derives the role from today's `resolveRecipientRole` and the copy group from `resolveCopyGroup`.

### Rulings made while writing this plan (review these)

- **F2-1 — the copy-grouping rules move into NS policies.**
  - Signals sends the true action type and the real domain id.
  - The generator emits a policy for every (domain, event) the network can produce. That way a future event processor can forward raw domain events unchanged.
  - A domain or action type added to network.json later needs a regenerated catalogue, or a policy added through the admin API. An event with no policy answers `422 no_policy`, a configuration error, which is logged.
- **F2-2 — HTML that Signals builds in code becomes template HTML or plain variables.** NS has no conditionals or loops.
  - **OTP box.** It becomes static template HTML around `{{otp}}`. This is byte-identical.
  - **Site link.** It becomes a `url` variable `siteUrl` inside a fixed anchor. Signals falls back to `FRONTEND_BASE_URL`. If neither exists, the welcome email is skipped and logged. Today that case prints the text "the platform" instead.
  - **Guardian bulk `orgList`.** It becomes a plain text variable joined as `A, B and C`, replacing the `<ol>`. This is a small, product-visible formatting change.
  - **Support `detailsTable`.** It becomes fixed template rows (`reference`, `name`, `phone`, `email`, `submittedAt`) plus an always-present `Attachments` row fed by `attachmentsSummary`, which reads `none` when there are no attachments.
- **F2-3 — brand overrides apply.**
  - A catalogue for a brand directory (e.g. `purple_dot/alimco`) merges, per key: the bundled defaults, then the network file, then the brand file.
  - Today's runtime never reaches the brand layer, so alimco's brand copy is unused. After cutover it goes live, as its authors intended.
  - Unknown keys stay ignored and are reported by the generator. Example: the 12 `service_provider.*` keys in `purple_dot`.
- **F2-4 — sender identity is deployment config.**
  - From name and address come from NS `EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS`, set in F4 to today's `INSTANCE_NAME` / `NOTIFICATION_FROM_EMAIL`.
  - The support email's "`<INSTANCE_NAME>` Support" From name becomes the deployment From name.
  - `reply_to` still flows per send for support.
- **F2-5 — `idempotency_key` replaces `dedupe_id`.** The keys are the same strings Signals uses today. A repeat now answers `200` with the original response instead of `200 duplicate`, which Signals treats as success.
- **F2-6 — support recipients.** `SUPPORT_EMAIL` may list several addresses, but `/v1/notify` has one `to.email`.
  - The first address is `to`.
  - The remaining addresses, plus `SUPPORT_CC_EMAIL`, go in `cc`, de-duplicated and capped at 10.
  - Recipients are therefore unchanged. The only visible difference is that they now appear in the Cc line.
- **F2-8 — an event's variables are checked against every template its policy names, not only the reachable ones (NS change, Task 0).**
  - **Today's rule:** NS rejects a variable that no *planned* template declares. Planned means after contact filtering.
  - **Why that breaks events:** a guardian OTP to a phone plans only the SMS template. The email-only fields (`parentName`, `org`, …) would then be refused as `unknown_variable`.
  - **The change:** the check widens to the union over every template the policy names, resolved for the request's locale. Each template still renders only its own variables, so a typo is still caught.
  - **OTP variable name:** the SMS `login_otp` template's variable is `message`, because the MSG91 flow variable name is fixed by the vendor. So the generated guardian and `otp.generic` email templates use `{{message}}` for the code. One OTP variable covers every channel, and the name never reaches the recipient.
  - **WhatsApp variable:** the WhatsApp content template's variable is `1`, the vendor's placeholder name, so the welcome event sends `1`.
- **F2-7 — one catalogue per bluedots-schemas directory that holds a network.json**, written next to it as `ns-catalogue.json`:
  - `blue_dot`, `blue_dot/up-gzb`, `blue_dot/ka-dhwd`, `blue_dot/upsdm`
  - `purple_dot`, `purple_dot/alimco`
  - `yellow_dot`
  - `orange_dot`, `orange_dot/onetac`

  Each catalogue carries:
  - the email templates, with brand colour per network id from today's `brand.ts` map;
  - the WhatsApp `welcome` template (`provider: twilio`, provider template id `HX3f2a5d7e4a18e5664124592a12a154eb`, variable `1`);
  - every policy for that directory.

  The SMS `login_otp` template is not included. NS seeds it from env per vendor, and its DLT text is per cluster.

## Review Focus

1. **A domain with no policy.** A recipient whose domain id is unknown to the catalogue, e.g. a network.json domain added later, gets `422 no_policy`.
   - A best-effort send logs `ns_rejected` with the code and continues.
   - The action or item request still succeeds.
   - → Task 4 test "a 422 from NS is logged and swallowed for best-effort events".
2. **The Keycloak token cannot be fetched.**
   - Critical sends (guardian OTP) fail with today's `NO_OTP_PROVIDER` → 503 shape.
   - Best-effort sends log and continue.
   - Nothing hangs: the token fetch shares the request timeout.
   - → Task 1 test "token fetch failure surfaces as a send failure, never a hang".
3. **A cached token expires mid-flight, or NS answers 401.** The client drops the cached token, fetches a new one once, retries once, then gives up.
   - → Task 1 test "401 refreshes the token once and retries once".
4. **The generated HTML drifts from today's.** Every case renders byte-identical apart from F2-2, proven by a golden test for every case and network.
   - → Task 2 test "every case renders identically through NS rules".
5. **A guardian OTP for a phone-only contact.** NS chooses SMS through `login_otp`, with the OTP as `message`.
   - The OTP never appears in Signals logs.
   - Test mode (`CREATE_TEST_OTP`) still skips the send.
   - → Task 5 test.

---

## File Structure (signals-dpg)

| File | Responsibility |
|---|---|
| `packages/notification/src/token_source.ts` (new) | `createClientCredentialsTokenSource({tokenUrl, clientId, clientSecret, fetchImpl, timeoutMs})` with caching |
| `packages/notification/src/notification_client.ts` (rewrite) | `NotificationClient.send(event: NotifyEvent): Promise<NotifyResult>` → `POST /v1/notify` |
| `packages/notification/src/notify_event.ts` (new) | `NotifyEvent` type, error classes |
| `apps/api/src/services/auth/keycloak_admin.ts` | Uses the shared token source |
| `apps/api/src/utils/notificationClient.ts` | Builds the client from `@/config` (endpoint + Keycloak client credentials) |
| `apps/api/src/notifications/events.ts` (new) | Event-type builders (`actionEvent`, `itemLifecycleEvent`, …), the single source of event names |
| `apps/api/src/notifications/*`, `services/guardian_otp.ts`, `routes/v1/support/submit_support.ts` | Send events |
| `tools/ns-catalogue/` (new) | Generator: copy inputs, shells, cases, network.json → `ns-catalogue.json`; golden test |
| Deleted from `apps/api/src/notifications/email/` | runtime rendering (`dispatch_email`, `messages`, `shells`, `substitute`, `parse_properties`, `email_cases` at runtime), `sms/*`; copy files move to `tools/ns-catalogue/inputs/` |

**bluedots-schemas:** `<dir>/ns-catalogue.json` for every directory listed in F2-7.

---

### Task 0 (notification-service): check event variables against every template the policy names

**Repo/branch:** notification-service, `feat/ns-event-variables` off `feat/ns-catalogue-seed` (PR #155). Worktree `.worktrees/ns-plan-f2/notification-service`.

**Files:**
- Modify: `src/lib/send/plan.ts`, `src/lib/send/__tests__/plan.test.ts`, `CLAUDE.md` (Send API v1 → Planning)

**Interfaces:**
- **Change.** For `event_type` sends, the unknown-variable union becomes the declared caller variables (`callerVariables`) of every template named by the policy's channels. The current rule uses only the templates that survive contact filtering.
- **How templates are resolved.** Each named template is resolved with `cachedResolveTemplate(channel, key, locale)`.
- **Failure handling.** A template that fails to resolve contributes nothing to the union and is not an error here. Its delivery is skipped or failed by the existing rules.
- **Unchanged.** `template_key` sends behave as before. Rendering still picks only each template's own variables.

- [ ] **Step 1: Failing tests** in `plan.test.ts`:
  - **"phone-only event accepts email-only variables":** policy `first_available` [email `guardian.account` declaring `message, parentName`; sms `login_otp` declaring `message`], `to: {phone}`, variables `{message, parentName}` → one sms delivery whose rendered variables are only `{message}`.
  - **"a variable no policy template declares is still unknown_variable"**.
  - **"a template that fails to resolve does not widen the union"**.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** Before the existing `union` computation, collect `policy.channels`. Resolve each one, reusing results already resolved for the candidates. Build the union from them. Keep the `template_key` path unchanged.
- [ ] **Step 4: Run.** `pnpm build && pnpm test`, plus the integration suite. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(send): event variables are checked against every template the policy names`

---

### Task 1: The `/v1/notify` client and the shared token source

**Files:**
- Create: `packages/notification/src/token_source.ts`, `packages/notification/src/notify_event.ts`, `packages/notification/src/__tests__/token_source.test.ts`, `packages/notification/src/__tests__/notification_client.test.ts`
- Modify:
  - `packages/notification/src/notification_client.ts` (rewrite) and `src/index.ts`
  - `packages/notification/package.json`: replace the `echo "no tests yet"` test script with vitest, following the other packages' setup
  - `apps/api/src/services/auth/keycloak_admin.ts`
- Delete: `packages/notification/src/create_auth_headers.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NotifyEvent {
    event_type: string;
    domain?: string | null;
    to: { email?: string; phone?: string };
    variables: Record<string, string | number | boolean>;
    priority?: 'urgent' | 'normal' | 'bulk';
    idempotency_key?: string;
    correlation_id?: string;
    cc?: string[];
    reply_to?: string;
    attachments?: { filename: string; contentType: string; data: string }[];
  }
  export type NotifyResult =
    | { ok: true; status: 200 | 202; body: { notification_event_id: string; correlation_id: string } }
    | { ok: false; status: number; error: string; kind?: 'caller' | 'configuration' };
  export class NotifyTransportError extends Error {} // network/timeout/token failure
  export interface TokenSource { token(): Promise<string>; invalidate(): void }
  export function createClientCredentialsTokenSource(cfg: {
    tokenUrl: string; clientId: string; clientSecret: string;
    fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number;
  }): TokenSource
  export class NotificationClient {
    constructor(cfg: { baseUrl: string; tokens: TokenSource; fetchImpl?: typeof fetch; timeoutMs?: number });
    send(event: NotifyEvent): Promise<NotifyResult>;
  }
  ```
- **`send` behaviour:**
  1. Body is `{ ...event, priority: event.priority ?? 'normal' }` as JSON. It POSTs to `new URL('/v1/notify', baseUrl)` with `authorization: Bearer <token>`, `content-type: application/json`, and `x-correlation-id` when present. The timeout defaults to 10 s.
  2. A `401` invalidates the token and retries once.
  3. A `2xx` returns `ok: true`.
  4. Any other status returns `ok: false` with `error`, read from the body (`error` field, else `http_<status>`), and `kind` when present.
  5. Network, timeout or token errors throw `NotifyTransportError` (message only; no body, no token).
- **Token source:**
  - It caches `access_token` until `expires_in - 30 s`, with a minimum of 10 s.
  - Concurrent `token()` calls share one in-flight fetch.
  - `invalidate()` drops the cache.
  - A non-2xx answer, or a missing `access_token`, throws an `Error` naming the status only.
- **`KeycloakAdminClient`** keeps its public API. Internally its `accessToken()` delegates to a token source built with the same URL and credentials, so there is one implementation.

- [ ] **Step 1: Write the failing tests.**

  `notification_client.test.ts` stubs `fetchImpl` and a fake `TokenSource`. It asserts:
  - the URL is exactly `<base>/v1/notify`, including when `baseUrl` has a trailing path or slash;
  - the method and headers: bearer, JSON, and the correlation header when given;
  - the body defaults `priority` to `normal`;
  - `202` gives `ok:true` with the body;
  - `422 {error:'no_policy',kind:'configuration'}` gives `ok:false` with `error` and `kind`;
  - "401 refreshes the token once and retries once": the first call answers 401 and the second 202. `invalidate` is called once and `fetch` twice. A second 401 gives `ok:false, status:401` with no third call;
  - "token fetch failure surfaces as a send failure, never a hang": `tokens.token()` rejects, and `send` rejects with `NotifyTransportError`;
  - a timeout uses fake timers and an `AbortSignal` → `NotifyTransportError`;
  - no log or error message contains the token or any variable value.

  `token_source.test.ts` asserts:
  - the form-encoded POST: `grant_type=client_credentials`, client id and secret;
  - caching until expiry minus 30 s;
  - concurrent calls cause one fetch;
  - `invalidate` forces a refetch;
  - a non-2xx answer throws without the response body.

- [ ] **Step 2: Run and confirm the tests fail.** Run `pnpm --filter notification test`, or the package's vitest command.

- [ ] **Step 3: Implement.** Follow the interfaces above, using `AbortSignal.timeout(timeoutMs)` for both fetches. In `keycloak_admin.ts`, replace the private token fields and `accessToken()` body with a `TokenSource`, and keep `forgetToken()` as `tokens.invalidate()`. Its existing tests must pass unchanged.

- [ ] **Step 4: Run.** Run the package tests, then `pnpm --filter api test` for the `keycloak_admin` tests, then the repo typecheck and build. Expected: everything passes.

- [ ] **Step 5: Commit.** `feat(notification): /v1/notify client with a shared client-credentials token source`

---

### Task 2: The catalogue generator and its golden test

**Files:**
- Create:
  - `tools/ns-catalogue/` as a workspace package (`package.json`, `tsconfig`, vitest config, following the repo's tools conventions)
  - `src/generate.ts` (`buildCatalogue(input)`)
  - `src/render_ns.ts`: a copy of NS's email rendering rules, for the golden test only
  - `src/cli.ts`: `pnpm --filter ns-catalogue generate <schemasRepoDir>`
  - `src/__tests__/generate.test.ts`, `src/__tests__/golden.test.ts`
- Move into `tools/ns-catalogue/src/legacy/`, so the golden test can render today's output:
  - `messages.default.properties`
  - `email_cases.ts`
  - `shells.ts`
  - `substitute.ts`
  - `parse_properties.ts`
  - `brand.ts` (colour map only)
  - `action_copy.ts` (`resolveRecipientRole`, `resolveCopyGroup`)

  Until Task 6, the runtime copies in `apps/api` stay where they are. In Task 6 the `apps/api` copies are deleted.

**Interfaces:**
- Produces:
  ```ts
  export interface CatalogueInput {
    networkId: string;                 // network.json id
    domains: string[];                 // network.json domain ids
    actionTypes: string[];             // network.json action types
    copy: Map<string, string>;         // merged per key: defaults < network < brand (F2-3)
    version: string;                   // e.g. git short SHA of the schemas repo + date
  }
  export function buildCatalogue(input: CatalogueInput): {
    catalogue: NsCatalogue;            // matches notification-service's catalogue format (PR #155)
    warnings: string[];                // unknown copy keys, domains with no role, etc.
  }
  ```
- **Template generation.** For each email case, the template is built by running today's shell code with token passthrough:
  - every `text` variable's value is the literal string `{{var}}`;
  - `ctaUrl` is `{{ctaUrl}}`;
  - `ctaColor` is the network colour;
  - `brandName` is `{{teamName}}`.

  `escapeHtml('{{x}}')` returns `{{x}}` unchanged, so the generated HTML is the exact shell with NS tokens in place.
- **The F2-2 replacements are done in the case inputs:**
  - `otpBox` is the `renderOtpBox('{{message}}')` output, and every `{{otp}}` token in guardian and `otp.generic` copy is renamed to `{{message}}` (F2-8);
  - `siteLink` is `renderSiteLink('{{siteUrl}}')`;
  - `orgList` is `{{orgList}}`;
  - `detailsTable` is a fixed-row table.
- **Variable contract per template:** `text` tokens become `type: 'string'`; `ctaUrl` and `siteUrl` become `type: 'url'`; `message` (the OTP) is `sensitive: true`. The WhatsApp `welcome` template declares one string variable, `1`. Every variable is `required: true`, except where the copy does not use it.
- **Subjects** keep `{{token}}` as they are. NS does not escape subjects, which matches today's `substitutePlain` followed by `oneLine`. The generator applies `oneLine` to the subject template.
- **Policies** follow the event table:
  - one per (domain in `domains`, event);
  - `user.welcome` also gets one with `domain: null`;
  - guardian and support policies get `domain: null`;
  - action policies cover every action type in `actionTypes`.
- **Output** passes NS's catalogue validation: provider rule, key slug, sizes. The WhatsApp entry carries `provider: 'twilio'`. Email entries omit `provider`.

- [ ] **Step 1: Write the failing tests.**
  - **`golden.test.ts`:** run the cases below across the networks `blue_dot`, `purple_dot`, `onest_yellow_dot` and `orange_dot`, using fixture copy maps (defaults plus that network's file from a fixture copy of bluedots-schemas). For each case, compare `renderToday` with `renderNs`:
    1. Build sample variable values. They must include characters that need escaping (`<b>&"'`).
    2. `renderToday` is the legacy `dispatchEmail` path, captured through an injected `notify` spy.
    3. `renderNs` takes the generated template and renders it with `render_ns.ts`, NS's rules:
       - HTML-escape every non-raw variable in the body (`&<>"'` the same way as NS);
       - no escaping in the subject;
       - collapse control characters in the subject.
    4. Assert `html` and `subject` are equal.

    Two kinds of case are exempt, and the test asserts their exact expected new form instead:
    - the F2-2 cases: the welcome without a site URL is skipped, plus the bulk `orgList` and the `detailsTable`;
    - copy that contains a literal `{{token}}` the case does not declare. Today that copy leaves the token verbatim; the test asserts the generator reports it as a warning.
  - **`generate.test.ts`:**
    - policy count and shape per network;
    - role mapping: `student` → profile/seeker, `individual_tutor_weera_counsellor` → offer/provider, `service_provider` → provider;
    - apply, shortlist and pre_shortlist all map to the apply copy;
    - brand layering (F2-3);
    - unknown-key warnings, such as the purple_dot `service_provider.*` keys;
    - the WhatsApp template;
    - the output parses as JSON and has no duplicate keys.

- [ ] **Step 2: Run and confirm the tests fail.**

- [ ] **Step 3: Implement** `generate.ts`, `render_ns.ts` and `cli.ts`. The CLI:
  1. walks the schemas repo directories listed in F2-7;
  2. reads `network.json`, the network `messages.properties` and the brand `messages.properties`;
  3. merges them over the bundled defaults;
  4. writes `<dir>/ns-catalogue.json`, pretty-printed and stably sorted;
  5. prints warnings.

  `render_ns.ts` must reproduce NS's `render.ts` email behaviour exactly. Read `notification-service/src/lib/templates/render.ts` (branch `feat/ns-catalogue-seed`) and copy its escaping and subject rules, with a header comment naming the source file.

- [ ] **Step 4: Run.** Run the tool's tests and the repo build. Expected: everything passes.

- [ ] **Step 5: Commit.** `feat(tools): ns-catalogue generator with a golden test against today's rendering`

---

### Task 3: Generate and commit the catalogues (bluedots-schemas)

**Files** (bluedots-schemas, branch `feat/ns-catalogues`): `<dir>/ns-catalogue.json` for every directory in F2-7, plus a README section.

- [ ] **Step 1:** In signals-dpg, run `pnpm --filter ns-catalogue generate <path-to-bluedots-schemas worktree>`. Record every warning in the report.
- [ ] **Step 2: Validate each file** against NS's real schema. Run it from a notification-service checkout of `feat/ns-catalogue-seed`:

  ```bash
  node -e "const {parseCatalogue}=require('./dist/lib/catalogue/schema.js');for(const f of process.argv.slice(1)){parseCatalogue(JSON.parse(require('fs').readFileSync(f,'utf8')));console.log('ok',f)}" <files…>
  ```

  Build NS first with `pnpm build`. Expected: `ok` for every file.
- [ ] **Step 3:** Check each file is under 1 MiB (`wc -c`).
- [ ] **Step 4:** Add a README section covering:
  - what `ns-catalogue.json` is;
  - that it seeds NS only where templates or policies are absent;
  - that live copy is edited through the NS admin API;
  - how to regenerate, using the command above.
- [ ] **Step 5: Commit.** `feat: notification-service catalogues generated from current copy`

---

### Task 4: Action, retire and item-lifecycle senders emit events

**Files** (signals-dpg):
- Create: `apps/api/src/notifications/events.ts`, with tests.
- Modify:
  - `notifications/dispatcher.ts`, `notify_actions.ts`, `notify_retire.ts`, `notify_item_lifecycle.ts`
  - `routes/v1/admin/participant.ts`, for aggregator onboarding
  - the tests for all of these, plus the notify-seam tests

**Interfaces:**
- Produces, in `events.ts`:
  - `actionEvent(actionType, shape)` → `` `action.${actionType}.${shape.toLowerCase()}` ``
  - `ITEM_EVENT = { create: 'item.created', create_incomplete: 'item.created_draft', update: 'item.updated', pause: 'item.paused', retire: 'item.retired' } as const`
  - `ITEM_ONBOARDED = 'item.onboarded_by_aggregator'`
  - `ACTION_CANCELLED_BY_RETIRE = 'action.cancelled_by_retire'`
  - `USER_WELCOME = 'user.welcome'`
  - `guardianEvent(kind | 'generic')` → `guardian.otp.<kind>`
  - `SUPPORT_REQUEST = 'support.request'`
- **Senders:**
  - Each sender now calls `getNotificationClient()?.send({ event_type, domain, to: { email }, variables, priority: 'normal', idempotency_key, correlation_id })`.
  - `domain` is the recipient's item domain: `plan.recipientDomain` for actions, the item's domain for lifecycle, `cp.domain` for retire.
  - `idempotency_key` uses today's `dedupe_id` strings (F2-5).
  - Variables are those in the event table. `name` and the aggregator fields are resolved exactly as today. `ctaUrl` comes from today's resolver; when it is missing the send is skipped (`no_cta_url`), as today.
  - `teamName` and `networkName` come from today's sources.
  - The case-id selection logic is deleted from Signals: `actionCaseId`, the profile/offer noun choice and `itemLifecycleCaseId`. That decision now lives in NS policies. The one exception is the choice between `create` and `create_incomplete` and the aggregator branch, which picks the *event*.
  - The `resolveNotifierConfig` gate becomes "client configured AND (FRONTEND_BASE_URL or UI_HOST_BINDINGS)". `NOTIFICATION_FROM_EMAIL` is no longer required.
  - Result handling, best effort: `ok:false` logs `{ event_type, status, error, kind }` as `ns_rejected` and continues. A `NotifyTransportError` logs `ns_unreachable` and continues.

- [ ] **Step 1: Write the failing tests.** Rewrite the dispatcher, retire, lifecycle and seam tests to assert the `send` payload for each case. Cover:
  - a connect inbound request to a `service_provider` recipient → `action.connect.inbound_request`, `domain: 'service_provider'`;
  - a shortlist status → `action.shortlist.inbound_status`;
  - a draft create → `item.created_draft`;
  - an aggregator create → `item.onboarded_by_aggregator`;
  - retire → `action.cancelled_by_retire`;
  - `idempotency_key` values match today's dedupe strings;
  - "a 422 from NS is logged and swallowed for best-effort events";
  - no HTML, subject, template or channel field is ever sent.
- [ ] **Step 2: Run and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Run the api unit tests, plus the affected integration tests per the repo's CLAUDE.md, then the build. Expected: everything passes.
- [ ] **Step 5: Commit.** `feat(notifications): action and item events on /v1/notify`

---

### Task 5: Guardian OTP, welcome and support emit events

**Files** (signals-dpg): `services/guardian_otp.ts`, `notifications/welcome.ts`, `routes/v1/support/submit_support.ts`, and their tests.

**Behaviour:**
- **Guardian.**
  - `send({ event_type: guardianEvent(kind), domain: null, to: contactType === 'phone' ? { phone } : { email }, variables: { message: otp, parentName, domain, org, teamName, …bulk: noun, orgList }, priority: 'urgent' })`.
  - `orgList` is the names joined as `A, B and C` (F2-2). `domain` stays the text variable it is today.
  - No idempotency key, as today.
  - `ok:false` or a transport error throws today's `GuardianOtpError('NO_OTP_PROVIDER')`, so the route still answers 503.
  - Test mode (`CREATE_TEST_OTP`) still skips the send.
  - The OTP is never logged.
- **Welcome.**
  - A single event: `send({ event_type: 'user.welcome', domain: signupDomain ?? null, to: { email?, phone? }, variables: { userName, appName, teamName, siteUrl, '1': name }, priority: 'urgent' })`. Both contact points are included when present. The policy's `all` mode fans out to email and WhatsApp, replacing the two separate calls.
  - If `siteUrl` cannot be resolved (F2-2), skip the send when there is no phone. When there is a phone, drop `email` from `to` so WhatsApp still goes out.
  - Failures are logged and swallowed, as today.
- **Support.**
  - `send({ event_type: 'support.request', domain: null, to: { email: recipients[0] }, cc: [...rest, ...supportCc] (dedupe, ≤10), reply_to, attachments, variables: { reference, type, name, fromSite, details, teamName, phone: phone ?? '—', email: email ?? '—', submittedAt, attachmentsSummary }, priority: 'normal', idempotency_key: reference })`.
  - `attachmentsSummary` is today's `filename (size)` list joined by `, `, or `none`.
  - `ok:false` or a transport error gives today's `502 SUPPORT_SEND_FAILED`.
  - The `SUPPORT_NOT_CONFIGURED` gate drops its `fromEmail` condition.

- [ ] **Step 1: Write the failing tests.** Rewrite `guardian_otp_dispatch`, `guardian_otp_send`, `welcome` and `submit_support` to assert:
  - the event payloads;
  - "phone-only guardian contact → `to: {phone}`, urgent, OTP only in `variables.message`";
  - test mode skips the send;
  - `ok:false` → 503 `NO_OTP_PROVIDER`;
  - the welcome fan-out payload, and the no-siteUrl rule;
  - support recipients and cc splitting, with a cap of 10, plus attachments passthrough;
  - `502` on failure.
- [ ] **Step 2: Run and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Run the api unit tests and the build. Expected: everything passes.
- [ ] **Step 5: Commit.** `feat(notifications): guardian OTP, welcome and support events on /v1/notify`

---

### Task 6: Remove runtime rendering, the HMAC client and unused config; docs

**Files** (signals-dpg):
- Delete:
  - From `apps/api/src/notifications/email/`: `dispatch_email.ts`, `messages.ts`, `shells.ts`, `substitute.ts`, `parse_properties.ts`, `email_cases.ts` and `messages.default.properties`. Their generator copies stay in `tools/ns-catalogue/src/legacy/`.
  - `notifications/sms/*`, the rendering parts of `brand.ts` (keep `buildCtaUrl` / `createCtaUrlResolver`), and the rendering parts of `support/build_support_email.ts` (keep the reference generator).
  - Their tests.
  - `packages/config` email-messages loader usage in `app.ts` (`getEmailMessages`).
  - `examples/schemas/*/messages.properties`, `examples/schemas/*/sms.properties` and `shipped_messages_copy.test.ts`.
- Modify:
  - `packages/config/src/secrets.ts`: remove `NOTIFICATION_SERVICE_KEY_ID`, `NOTIFICATION_SERVICE_SECRET`, `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_REPLY_TO`, `EMAIL_MESSAGES_PATH` and `SMS_TEMPLATE_ID`. Keep `NOTIFICATION_SERVICE_ENDPOINT`, `FRONTEND_BASE_URL`, `UI_HOST_BINDINGS` and the support fields.
  - The `secrets_schemas` test and the `.env.example` NS block (endpoint + "uses KEYCLOAK_API_CLIENT_ID/SECRET").
  - `apps/api/CLAUDE.md`, the notifications docs (`docs/operations/email-copy-overrides.md` → replace with "copy is edited in notification-service via its admin API") and `docs/operations/guardian-otp-templates.md`.
- **Requirement:** `pnpm typecheck`, `pnpm test` and the build pass with zero references to the removed modules or env vars. Check with `git grep -n "basic_email\|NOTIFICATION_SERVICE_SECRET\|EMAIL_MESSAGES_PATH\|SMS_TEMPLATE_ID\|create_auth_headers"`, which must print nothing outside `tools/ns-catalogue`.

- [ ] **Step 1:** Delete and modify as listed. Fix the compile errors this exposes in callers.
- [ ] **Step 2:** Run the grep check and the full repo checks, following the repo CLAUDE.md commands (lint, typecheck, test, build). Expected: clean.
- [ ] **Step 3: Commit.** `refactor(notifications): remove in-app email rendering and the HMAC notification client`

---

## Done when

- signals-dpg lint, typecheck, unit and integration tests and build are green.
- `tools/ns-catalogue` golden test passes for every case, with F2-2 the only differences.
- Every Signals send is a `/v1/notify` event with a bearer token. No HTML, subject or vendor id leaves Signals.
- bluedots-schemas has a validated `ns-catalogue.json` for every directory in F2-7.
- Signals' behaviour (who gets what, when, and which failures surface) is unchanged, except for F2-2 to F2-6.

## Follow-ups owned by later plans

- **F3:** Keycloak login OTP over `/v1/notify` with HMAC v2.
- **F4:**
  - In the chart, mount the catalogue (`NS_SEED_FILE`), set Signals' NS env (endpoint + Keycloak client), and set NS `EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS`.
  - Drop the Signals `messages.properties` ConfigMap delivery.
  - e2e asserts via Mailpit against the event table.
  - NS deletes legacy `/notify`.
