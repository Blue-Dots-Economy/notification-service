# NS Stage 1 Plan F4 — Cutover Wiring (Part A) and Legacy `/notify` Removal (Part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy what Plans A–F3 built. Part A wires the charts so notification-service seeds each cluster's catalogue, sends from the right address, and serves Signals and Keycloak over `/v1/notify`. It also moves the e2e suite to assert delivered mail in Mailpit. Part B, one release later, deletes legacy `/notify`, HMAC v1 and the legacy worker path.

**Architecture:**
- **Two releases (F4-1).**
  - **Part A** ships in the Stage 1 release, together with the NS stack (#147–#156) and signals-dpg#792. NS still accepts legacy `/notify` with HMAC v1, so Signals pods running the old image during the rolling upgrade keep delivering.
  - **Part B** merges for the *next* release. By then every cluster runs the new Signals image and the 24 h recovery window has drained.
- **Catalogue delivery.** It follows the existing schemas pattern: `scripts/fetch-configs.sh` downloads `<network>[/<brand>]/ns-catalogue.json` from bluedots-schemas. The NS chart renders it into a ConfigMap only when the file is on disk, mounts it, and sets `NS_SEED_FILE`.
- **e2e.** e2e stops reading NS Redis. NS sends real SMTP to the stack's Mailpit, and journeys assert subject, body and recipients through Mailpit's HTTP API.

**Tech Stack:**
- bluedots-automation: Helm 3, bash, OpenTofu templates, GitHub Actions.
- bluedots-e2e: TypeScript, vitest, docker compose.
- notification-service: Fastify 5, TypeScript, vitest.

**Spec:** notification-service `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04), §Stages items 6, 9 and 10, plus §Security (retire raw provider ids, free-text SMS bodies, `basic_email`, WhatsApp `other`).

**Plan F context:**

| Plan | Scope | PRs / plan |
|---|---|---|
| F1 | Catalogue seed + export | NS#155 |
| F2 | Signals on `/v1/notify` | signals-dpg#792, NS#156, bluedots-schemas#47 |
| F3 | Keycloak OTP plugin on `/v1/notify` with HMAC v2, plus email OTP through NS | `2026-10-06-ns-stage1-f3-*.md` |
| F4 | This plan | — |

Plan G (per-cluster OTP flip to `http`) is out of scope.

## Global Constraints

- **Part A changes no NS source.** Legacy `/notify`, `legacyHmacV1`, the NS internal-secrets key `dpg-api-client` and the `signals_notification_secret` random password all stay through Part A.
- **Part B is NS + automation only.** It merges after the Part B release gate (see Rollout runbook). It is never folded into Part A's PRs.
- **Sender identity.** `EMAIL_FROM_ADDRESS` is the cluster's `smtp_user`, the value `NOTIFICATION_FROM_EMAIL` uses today. `EMAIL_FROM_NAME` is the cluster's `_smtp_from_display` anchor (F4-2).
- **One catalogue per cluster (ruling R3).** A cluster with a brand uses its brand directory's `ns-catalogue.json` only; a cluster without one uses the network directory's. There is no fallback: seeding keeps whichever copy reaches the first boot. Read from bluedots-schemas at the ref `fetch-configs.sh` already uses for that cluster.
- **Seeding is absent-only.** A catalogue change seeds only missing rows. Edits to live copy go through the NS admin API (F1).
- **`login_otp` precondition (F2 R15).** On every cluster, the SMS `login_otp` template is configured before the first NS boot with `NS_SEED_FILE`:
  - **msg91:** `SMS_LOGIN_OTP_TEMPLATE_ID`.
  - **pinnacle:** `PINNACLE_LOGIN_OTP_TEMPLATE_ID` plus `SMS_LOGIN_OTP_BODY`.
- **bluedots-infra-deployments is private and partly encrypted.** Per-cluster value edits are runbook steps, never tasks in this plan.
- **Standing rules.**
  - Public repos: state rules positively; no vulnerability narratives.
  - Never run `vitest --root /`. Never use bare `git stash`.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Read each repo's CLAUDE.md first.
  - Nothing is pushed without explicit approval, and every force-push needs its own approval.
- **Branches.**
  - automation Part A: `feat/ns-cutover-wiring`, stacked on `feat/ns-content-resolver`.
  - e2e Part A: `feat/ns-mailpit-e2e`, stacked on `feat/ns-service-auth`.
  - NS Part B: `feat/ns-legacy-removal`, stacked on `feat/ns-event-variables`.
  - automation Part B: `feat/ns-legacy-key-removal`, stacked on `feat/ns-cutover-wiring`.

### Rulings made while writing this plan (review these)

- **F4-1 — two releases.** This is the user's decision. Helm rolls pods one by one, so old Signals pods talk to new NS pods during an upgrade. Legacy `/notify` therefore lives one release longer, and the removal lands once every cluster runs new Signals.
- **F4-2 — the From name is `_smtp_from_display`.** This is the user's decision. It is the name Keycloak's emails already show: "Blue Dots", "Purple Dots", "Orange Dots", and "Aggregator" on up-sdm. The From address is `smtp_user`.
- **F4-3 — the catalogue rides `fetch-configs.sh`; the chart renders on file presence.**
  - `fetch-configs.sh signals` fetches the brand catalogue for a branded cluster, or the network catalogue for an unbranded one (R3, no fallback). It fails the deploy if that file is missing or invalid, and it requires `jq`.
  - The chart's `.Files.Get` decides whether the ConfigMap, the mount and `NS_SEED_FILE` exist. That keeps CI's bare `helm template` rendering (it never fetches) while a real deploy cannot lose the catalogue silently.
- **F4-4 — mount path `/app/seed`.** It is a directory mount, and `NS_SEED_FILE=/app/seed/ns-catalogue.json`. The path is distinct from `/app/config` (internal-secrets, read-only secret) and `/app/content` (content resolver).
- **F4-5 — a checksum annotation rolls NS on a catalogue change.** Only absent rows are seeded. The `helm/CLAUDE.md` note says so, so nobody expects a catalogue edit to change live copy.
- **F4-6 — `MSG91_TEMPLATE_ID` leaves the NS secret.**
  - NS never reads it: NS reads `SMS_LOGIN_OTP_TEMPLATE_ID`, which is already rendered from the same variable.
  - Keycloak's own `msg91TemplateId` is unchanged.
- **F4-7 — Keycloak email OTP is a chart value.**
  - `otpEmailProvider` (`smtp` by default, or `http`) renders `KC_SPI_OTP_EMAIL__PROVIDER`.
  - When either `smsProvider` or `otpEmailProvider` is `http`, the chart renders the shared NS block (`SMS_HTTP_URL`, `SMS_HTTP_KEY_ID`, `SMS_HTTP_TIMEOUT_MS`, …), whose default URL now ends `/v1/notify`.
  - The env names must equal those in Plan F3's NS client. Task A4 Step 0 confirms this.
- **F4-8 — e2e asserts delivery, not acceptance.**
  - A new capability, `mail`, means "the harness can read the stack's Mailpit".
  - Notification journeys require `['http', 'mail']`. The Redis notification probe and `expectNotificationQueued` are deleted, because v1 writes no `dedupe:*` keys and the spec takes e2e off NS Redis.
- **F4-9 — no SMS leaves the e2e stack.**
  - Guardian journeys use an email-only guardian contact, so `first_available` plans email only.
  - NS still gets `SMS_PROVIDER=msg91` with a dummy key and a dummy `SMS_LOGIN_OTP_TEMPLATE_ID`, so the guardian policies (which name `sms/login_otp`) publish at seed time.
- **F4-10 — e2e reads catalogues from the schemas checkout it already uses** (`BLUEDOTS_SCHEMAS_PATH`, `ref: main` in `journey.yml`). The catalogues are on `main` once bluedots-schemas#47 merges, which is therefore a precondition for the e2e PR's CI.
- **F4-11 — Part B dead-letters a legacy-shaped job instead of crashing.**
  - Recovery (24 h) or a DLQ replay can still hand the worker a job without `v1`.
  - Such a job is dead-lettered with reason `legacy_job_shape` and counted in `ns_job_dlq_total{reason="legacy_job_shape"}`.
- **F4-12 — Part B keeps `GET /providers`, which the spec lists.**
  - It now answers `{name, vendor, renders}` per channel.
  - The legacy `templates` map and variables schema go with the fields that produced them.
- **F4-13 — Part B moves `login_otp` seeding to explicit env reads:**
  - msg91 → `SMS_LOGIN_OTP_TEMPLATE_ID`;
  - pinnacle → `PINNACLE_LOGIN_OTP_TEMPLATE_ID`, with the body from `SMS_LOGIN_OTP_BODY`.

  Seeding no longer goes through `provider.templates` / `provider.bodies`, which Part B deletes.

## Review Focus

1. **`EMAIL_FROM_ADDRESS` is missing on a cluster.** Every v1 email would fail permanently with "email sender not configured". The chart refuses to render instead, the same way it already refuses a missing mail transport.
   - → Task A2 test "render fails without EMAIL_FROM_ADDRESS".
2. **No catalogue file on disk** (CI render, or an operator rendering by hand). The chart renders with no catalogue ConfigMap, no `/app/seed` mount and no `NS_SEED_FILE`, never with a dangling `NS_SEED_FILE` that NS would log as unreadable.
   - → Task A1 test "no file: no ConfigMap, no mount, no NS_SEED_FILE".
3. **The catalogue changes between deploys.** The pod template's `checksum/catalogue` changes, so NS restarts and seeds new absent rows. Existing rows are untouched.
   - → Task A1 test "checksum follows the file".
4. **An old Signals pod posts legacy `/notify` mid-rollout in Part A.** It still authenticates, because internal-secrets keeps `dpg-api-client`.
   - → Task A3 test "Part A keeps dpg-api-client in internal-secrets".
5. **After Part B, the worker meets a job with no `v1` plan** (recovery or DLQ replay). It dead-letters it as `legacy_job_shape` and keeps working; nothing throws out of `processJob`.
   - → Task B1 test.

---

## File Structure

**bluedots-automation (Part A)**

| File | Change |
|---|---|
| `scripts/fetch-configs.sh` | signals target: fetch the NS catalogue; drop the Signals messages (and sms, after rebase) fetches |
| `helm/signals/charts/notification-service/templates/configmap-catalogue.yaml` (new) | `<fullname>-catalogue` ConfigMap from `files/catalogue/ns-catalogue.json` |
| `helm/signals/charts/notification-service/templates/configmap.yaml` | `NS_SEED_FILE` when the file exists; `EMAIL_FROM_ADDRESS` render guard |
| `helm/signals/charts/notification-service/templates/deployment.yaml` | `/app/seed` mount + `checksum/catalogue` |
| `helm/signals/charts/notification-service/values.yaml` | `config.EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` defaults (empty), comments; drop `MSG91_TEMPLATE_ID` |
| `helm/signals/charts/api/templates/schemas-configmap.yaml`, `deployment.yaml` | remove `messages.properties` (and `sms.properties`) delivery |
| `helm/signals/charts/api/values.yaml`, `helm/signals/values.yaml` | remove Signals HMAC/SMS/from env |
| `opentofu/aws/template/global-values.yaml` | NS `EMAIL_FROM_*`; drop `notificationKeyId`, `NOTIFICATION_FROM_EMAIL` |
| `opentofu/aws/modules/output-file/global-secrets.yaml.tfpl` | drop Signals `notificationSecret` / `NOTIFICATION_SERVICE_SECRET`, NS `MSG91_TEMPLATE_ID` |
| `helm/keycloak/charts/keycloak/{values.yaml,templates/configmap.yaml}` | `/v1/notify` default, `otpEmailProvider` |
| `dockerfiles/keycloak/providers/README.md` | source branch `main`, HMAC v2 note |
| `helm/signals/tests/render_test.sh` (new), `.github/workflows/ci.yml` | render assertions in CI |
| `.gitignore`, `helm/CLAUDE.md` | catalogue file ignored; delivery notes |

**bluedots-e2e (Part A)**

| File | Change |
|---|---|
| `src/targets/target_discovery.ts` | `ResolvedTarget` gains `networkId`, `cataloguePath` |
| `src/env/capabilities.ts` | `Capability` gains `'mail'` |
| `src/env/compose/{ports.ts,compose_provider.ts}` | discover Mailpit's port; `endpoints.mailpit`; bind-source check for the catalogue |
| `src/env/compose/{overlay.ts,stack_env.ts}` | NS env (SMTP, from, network, seed, bearer); Signals env cleanup; support env |
| `src/awaiters/mail.ts`, `src/awaiters/mail_probe.ts` (new) | Mailpit probe and awaiter |
| `src/steps/projections/email_delivered.ts` (new), `src/steps/actors/*` | `expectEmailDelivered`; baselines via the mail probe; new actors |
| Deleted | `src/awaiters/notification.ts`, `notification_probe.ts`, `src/steps/projections/notification_queued.ts` and their tests |
| `journeys/notifications/*`, `journeys/index.ts` | J11–J13 on Mailpit; J21–J24 new |
| `tests/stack/boot_stack.ts` | mail probe instead of the Redis notification probe |

**notification-service (Part B):** `src/routes/notify.ts` (delete), `src/app.ts`, `src/plugins/auth.ts`, `src/lib/auth/hmac.ts`, `src/lib/dedupe_key.ts` (delete), `src/lib/worker.ts`, `src/types/{index,provider}.ts`, `src/lib/providers/**`, `src/lib/templates/seed.ts`, `src/routes/providers.ts`, `src/lib/utils/{provider-docs,openapi}.ts`, tests, `README.md`, `CLAUDE.md`, `example.env`.

**bluedots-automation (Part B):** the tfpl internal-secrets JSON, `helm/signals/values.yaml`, `modules/random_passwords`, `_common/output-file.hcl`, `helm/CLAUDE.md`.

---

# Part A — ships with the Stage 1 release

### Task A0 (gated): Bring the automation NS stack up to `main`

**Why:** `feat/ns-postgres` → `feat/ns-network-config` → `feat/ns-service-auth` → `feat/ns-content-resolver` (PRs #260–#263) are 11 commits behind automation `main`. `main` carries #238, which adds the Signals `sms.properties` ConfigMap that Task A3 removes.

- [ ] **Step 1: Ask the user.** Rebasing the four stacked branches rewrites published PR branches. That is a force-push, which needs an explicit per-action "yes". Offer two options:
  - (a) rebase each branch onto its new base in order, then force-push all four;
  - (b) leave #260–#263 untouched, and have `feat/ns-cutover-wiring` merge `origin/main` once at its base. This needs no force-push, but conflicts are resolved on this branch.
- [ ] **Step 2:** Carry out the chosen option. After it, `git merge-base --is-ancestor origin/main HEAD` holds on the branch Task A1 starts from.
- [ ] **Step 3: Verify.** Run `helm lint helm/signals --set global.existingSecret=ci-smoke` and `bash helm/signals/tests/run.sh`. Expected: clean, as before the rebase.

---

### Task A1: Deliver the cluster's catalogue to NS (automation)

**Files:**
- Create: `helm/signals/charts/notification-service/templates/configmap-catalogue.yaml`, `helm/signals/tests/render_test.sh`
- Modify:
  - `scripts/fetch-configs.sh` (signals target)
  - `helm/signals/charts/notification-service/templates/{configmap.yaml,deployment.yaml}`
  - `.gitignore`
  - `.github/workflows/ci.yml` (one step)
  - `helm/CLAUDE.md`

**Interfaces:**
- **Produces:**
  - The file `helm/signals/charts/notification-service/files/catalogue/ns-catalogue.json` (gitignored, fetched).
  - A ConfigMap `<ns-fullname>-catalogue` with key `ns-catalogue.json`.
  - A volume `catalogue` mounted at `/app/seed`, read-only.
  - The env var `NS_SEED_FILE=/app/seed/ns-catalogue.json`.
  - The pod annotation `checksum/catalogue`.
- **Consumes:** `BRAND` and `NETWORK` from `read_anchor` (the `_brand` and `_network` anchors; never `consentBrand`), and `RAW` from the signals target.

- [ ] **Step 1: Write the failing render test** `helm/signals/tests/render_test.sh`:

```bash
#!/usr/bin/env bash
# Render assertions for the notification-service subchart that `helm lint`
# cannot express: what renders when a fetched file is or is not on disk.
set -euo pipefail
cd "$(dirname "$0")"
CHART="../charts/notification-service"
CAT_DIR="$CHART/files/catalogue"
BASE=(--namespace signals --set config.SMTP_AWS_SES=true --set config.EMAIL_FROM_ADDRESS=from@example.test --set postgres.host=pg.test)
fail() { echo "FAIL: $*" >&2; exit 1; }
render() { helm template ns "$CHART" "${BASE[@]}" "$@"; }

backup=""
if [ -f "$CAT_DIR/ns-catalogue.json" ]; then backup="$(mktemp)"; cp "$CAT_DIR/ns-catalogue.json" "$backup"; fi
restore() { rm -f "$CAT_DIR/ns-catalogue.json"; [ -n "$backup" ] && cp "$backup" "$CAT_DIR/ns-catalogue.json" || true; }
trap restore EXIT

# no file: no ConfigMap, no mount, no NS_SEED_FILE
rm -f "$CAT_DIR/ns-catalogue.json"
out="$(render)"
grep -q 'ns-catalogue.json' <<<"$out" && fail "catalogue rendered without a file"
grep -q 'NS_SEED_FILE' <<<"$out" && fail "NS_SEED_FILE set without a file"
grep -q 'mountPath: /app/seed' <<<"$out" && fail "/app/seed mounted without a file"

# file present: ConfigMap, mount, env, checksum
mkdir -p "$CAT_DIR"
printf '{"version":"t1","templates":[],"policies":[]}' > "$CAT_DIR/ns-catalogue.json"
out="$(render)"
grep -q 'name: ns-notification-service-catalogue' <<<"$out" || fail "no catalogue ConfigMap"
grep -q 'NS_SEED_FILE: "/app/seed/ns-catalogue.json"' <<<"$out" || fail "NS_SEED_FILE missing"
grep -q 'mountPath: /app/seed' <<<"$out" || fail "/app/seed not mounted"
sum1="$(grep 'checksum/catalogue' <<<"$out")" || fail "no checksum/catalogue"

# checksum follows the file
printf '{"version":"t2","templates":[],"policies":[]}' > "$CAT_DIR/ns-catalogue.json"
sum2="$(render | grep 'checksum/catalogue')"
[ "$sum1" != "$sum2" ] || fail "checksum did not change with the file"
echo "render_test: ok"
```

  Then add a step to the `helm` job in `.github/workflows/ci.yml`, after the promtool step:

```yaml
      - name: notification-service render assertions
        run: bash helm/signals/tests/render_test.sh
```

- [ ] **Step 2: Run it and confirm it fails.** Run `bash helm/signals/tests/render_test.sh`. Expected: `FAIL: no catalogue ConfigMap`.

- [ ] **Step 3: Implement the chart.**

  `templates/configmap-catalogue.yaml`:

```yaml
{{- /*
  The cluster's NS catalogue (Plan F1), fetched by scripts/fetch-configs.sh.
  Rendered on FILE PRESENCE: CI renders without fetching, and fetch-configs
  is what makes a real deploy fail loudly when the file is missing.
  Byte-for-byte: the catalogue's {{ "{{token}}" }} placeholders belong to NS.
*/ -}}
{{- with .Files.Get "files/catalogue/ns-catalogue.json" }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "dpg-notification-service.fullname" $ }}-catalogue
  labels:
    {{- include "dpg-notification-service.labels" $ | nindent 4 }}
data:
  ns-catalogue.json: {{ . | quote }}
{{- end }}
```

  In `templates/configmap.yaml`, after the `NS_CONTENT_FILE` block:

```yaml
  {{- if .Files.Get "files/catalogue/ns-catalogue.json" }}
  NS_SEED_FILE: "/app/seed/ns-catalogue.json"
  {{- end }}
```

  In `templates/deployment.yaml`:
  - Add an annotation beside `checksum/content`:

```yaml
        {{- if .Files.Get "files/catalogue/ns-catalogue.json" }}
        checksum/catalogue: {{ include (print $.Template.BasePath "/configmap-catalogue.yaml") . | sha256sum }}
        {{- end }}
```

  - Add the mount beside `content`:

```yaml
            {{- if .Files.Get "files/catalogue/ns-catalogue.json" }}
            # Read once at boot (seed). Not under /app/config (internal-secrets) or /app/content.
            - name: catalogue
              mountPath: /app/seed
              readOnly: true
            {{- end }}
```

  - Add the volume beside `content`:

```yaml
        {{- if .Files.Get "files/catalogue/ns-catalogue.json" }}
        - name: catalogue
          configMap:
            name: {{ include "dpg-notification-service.fullname" . }}-catalogue
        {{- end }}
```

- [ ] **Step 4: Implement the fetch.** In `scripts/fetch-configs.sh`, signals target, after the email-copy block:

```bash
    # ── notification-service catalogue (NS Stage 1 Plan F1/F4) ──────────────
    # One per cluster: the brand's own catalogue when it has one, else the
    # network's. REQUIRED — a deploy without it would leave NS with no
    # templates or policies, so try_fetch fails the deploy. Cleared first
    # because the chart renders on file presence.
    CAT_DIR="$REPO_ROOT/helm/signals/charts/notification-service/files/catalogue"
    mkdir -p "$CAT_DIR"
    rm -f "$CAT_DIR/ns-catalogue.json"
    cat_cands=()
    [ -n "$BRAND" ] && cat_cands+=("${RAW}/${NETWORK}/${BRAND}/ns-catalogue.json")
    cat_cands+=("${RAW}/${NETWORK}/ns-catalogue.json")
    try_fetch "$CAT_DIR/ns-catalogue.json" "${cat_cands[@]}"
    if command -v jq >/dev/null 2>&1; then
      jq -e '.version and (.templates|type=="array") and (.policies|type=="array")' \
        "$CAT_DIR/ns-catalogue.json" >/dev/null \
        || { echo "ERROR: fetched ns-catalogue.json is not a catalogue" >&2; exit 1; }
    fi
    echo "  ns catalogue -> ${CAT_DIR}/ns-catalogue.json"
```

  Add `helm/signals/charts/notification-service/files/catalogue/*.json` to `.gitignore`, under the "Network + consent config" block.

- [ ] **Step 5: Docs.** Add a `helm/CLAUDE.md` subsection, "NS catalogue rides fetch-configs":
  - which file is fetched (brand first, then network);
  - the `/app/seed` path;
  - seeding is absent-only, so live copy is edited through the NS admin API and a catalogue change only adds missing rows;
  - the checksum restart.

- [ ] **Step 6: Verify.**
  1. Run `bash helm/signals/tests/render_test.sh`. Expected: `render_test: ok`.
  2. Run `helm lint helm/signals --set global.existingSecret=ci-smoke`. Expected: clean.
  3. Do a manual fetch check against the real repo: `scripts/fetch-configs.sh signals --global-values opentofu/aws/template/global-values.yaml --network blue_dot --brand up-gzb --ref main`. Expected: `blue_dot/up-gzb/ns-catalogue.json` lands in the directory. With `--brand upsdm` it is `blue_dot/upsdm/ns-catalogue.json`. With `--brand nope`, the network fallback is used.
  4. Remove the fetched file afterwards.

- [ ] **Step 7: Commit.** Message: `feat(ns): seed each cluster's catalogue from bluedots-schemas`

---

### Task A2: NS sender identity, and remove a dead secret (automation)

**Files:**
- Modify:
  - `helm/signals/charts/notification-service/{values.yaml,templates/configmap.yaml}`
  - `opentofu/aws/template/global-values.yaml` (the `notification-service.config` block)
  - `opentofu/aws/modules/output-file/global-secrets.yaml.tfpl` (the NS secrets)
  - `helm/signals/tests/render_test.sh`

- [ ] **Step 1: Write the failing test.** Append to `render_test.sh`:

```bash
# render fails without EMAIL_FROM_ADDRESS (every v1 email would fail permanently)
if helm template ns "$CHART" --namespace signals --set config.SMTP_AWS_SES=true --set postgres.host=pg.test >/dev/null 2>&1; then
  fail "rendered without EMAIL_FROM_ADDRESS"
fi
out="$(render --set config.EMAIL_FROM_NAME='Blue Dots')"
grep -q 'EMAIL_FROM_ADDRESS: "from@example.test"' <<<"$out" || fail "EMAIL_FROM_ADDRESS not rendered"
grep -q 'EMAIL_FROM_NAME: "Blue Dots"' <<<"$out" || fail "EMAIL_FROM_NAME not rendered"
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: `FAIL: rendered without EMAIL_FROM_ADDRESS`.

- [ ] **Step 3: Implement.**
  - **Guard in `templates/configmap.yaml`**, under the transport guard:

```yaml
{{- /* Send API v1 sends every email from EMAIL_FROM_ADDRESS; without it each one fails permanently. */}}
{{- if not .Values.config.EMAIL_FROM_ADDRESS }}
{{- fail "notification-service: config.EMAIL_FROM_ADDRESS is required (the From address for every email)." }}
{{- end }}
```

  - **`values.yaml` `config:`:** add the following with a comment ("From for every v1 email. The address must be a mailbox the relay accepts as sender, usually `SMTP_USER`."). Remove `MSG91_TEMPLATE_ID` from the secrets block, together with its comment.

```yaml
    EMAIL_FROM_ADDRESS: ""
    EMAIL_FROM_NAME: ""
```

  - **Template `global-values.yaml`:** under `notification-service.config`, add:

```yaml
    # Sender identity for every email NS sends (Plan F4, F4-2): the same
    # display name and mailbox Keycloak's emails use.
    EMAIL_FROM_ADDRESS: *smtp_user
    EMAIL_FROM_NAME: *smtp_from_display
```

  - **tfpl:** delete `MSG91_TEMPLATE_ID: "${msg91_template_id}"` from `notification-service.secrets.data`. `SMS_LOGIN_OTP_TEMPLATE_ID` in `config` stays as the single source, and its comment loses the sentence about the deleted key.
  - **Other charts that render NS** (the umbrella's CI smoke values, if any) get `config.EMAIL_FROM_ADDRESS` so the CI `helm template` step still renders. Check that the existing `helm template` step in `ci.yml` passes `-f helm/global-resources.yaml`. Add `--set notification-service.config.EMAIL_FROM_ADDRESS=ci@example.test` to the signals render lines if the guard trips there.

- [ ] **Step 4: Verify.** Run `bash helm/signals/tests/render_test.sh`, then the `helm lint` and `helm template` commands exactly as `ci.yml` runs them. Expected: all pass.

- [ ] **Step 5: Commit.** Message: `feat(ns): send from the cluster's display name and mailbox; drop an unread secret`

---

### Task A3: Signals uses its Keycloak token, not the HMAC pair or in-app copy (automation)

**Files:**
- Modify:
  - `helm/signals/values.yaml`: the `api.secrets` anchors `notificationKeyId` / `notificationSecret` and the `data` keys `NOTIFICATION_SERVICE_KEY_ID`, `NOTIFICATION_SERVICE_SECRET`, `SMS_TEMPLATE_ID`, plus the `consentNetwork`/`consentBrand` comment.
  - `helm/signals/charts/api/values.yaml` (the same keys).
  - `opentofu/aws/template/global-values.yaml` (`api.secrets.notificationKeyId`, `api.config.NOTIFICATION_FROM_EMAIL`).
  - tfpl (`api.secrets.notificationSecret`, `api.secrets.data.NOTIFICATION_SERVICE_SECRET`).
  - `helm/signals/charts/api/templates/{schemas-configmap.yaml,deployment.yaml}`.
  - `scripts/fetch-configs.sh` (the email-copy block, plus the sms block after A0).
  - `.gitignore` (`files/messages`, plus `files/sms` after A0).
  - `helm/CLAUDE.md` ("Email copy rides the signals consent ConfigMap", and "SMS templates ride the same ConfigMap" after A0).
  - `helm/signals/tests/render_test.sh`.
- **Keep:**
  - `NOTIFICATION_SERVICE_ENDPOINT`;
  - `KEYCLOAK_API_CLIENT_ID` / `KEYCLOAK_API_CLIENT_SECRET`;
  - NS `internalSecrets` with **both** `dpg-api-client` and `keycloak` (F4-1);
  - `random_passwords` `signals_notification_secret` (Part B removes it).

- [ ] **Step 1: Write the failing test.** Append to `render_test.sh` a render of the **umbrella** chart's api and NS internal-secret. Run `helm dependency build helm/signals` first if `charts/` lacks packaged deps; follow `ci.yml`'s order.

```bash
UMB=(helm template signals ../ --namespace signals -f ../../global-resources.yaml \
  --set global.existingSecret=ci-smoke --set notification-service.config.EMAIL_FROM_ADDRESS=ci@example.test \
  --set notification-service.postgres.host=pg.test)
api="$("${UMB[@]}" --show-only charts/api/templates/secret.yaml 2>/dev/null || true)"
grep -q 'NOTIFICATION_SERVICE_SECRET' <<<"$api" && fail "Signals still gets the HMAC secret"
grep -q 'NOTIFICATION_SERVICE_KEY_ID' <<<"$api" && fail "Signals still gets the HMAC key id"
grep -q 'SMS_TEMPLATE_ID' <<<"$api" && fail "Signals still gets SMS_TEMPLATE_ID"
schemas="$("${UMB[@]}" --show-only charts/api/templates/schemas-configmap.yaml 2>/dev/null || true)"
grep -q 'messages.properties' <<<"$schemas" && fail "Signals still gets messages.properties"
# Part A keeps dpg-api-client so old Signals pods keep delivering mid-rollout (F4-1)
ns="$("${UMB[@]}" --show-only charts/notification-service/templates/internal-secret.yaml)"
grep -q 'dpg-api-client' <<<"$ns" || fail "Part A must keep dpg-api-client in internal-secrets"
```

  Name the secret template file as it exists in the api chart (`templates/secret.yaml` or the repo's equivalent). Read the chart before writing the `--show-only` path. If the default internal-secrets JSON in `helm/signals/values.yaml` lacks `dpg-api-client`, assert on the value the tfpl renders instead, by grepping the tfpl. Either way the assertion is that Part A keeps the key.

- [ ] **Step 2: Run it and confirm it fails.** Expected: `FAIL: Signals still gets the HMAC secret`.

- [ ] **Step 3: Implement.**
  1. Delete the keys and anchors listed under Files, and every `*notification_key_id` / `*notification_secret` reference to them. Keep the `internalSecrets` JSON entry `dpg-api-client`. In tfpl it is rendered from `${signals_notification_secret}`, which stays.
  2. In `schemas-configmap.yaml`, delete both `messages.properties` blocks, from the "Per-network email copy" comment to its `{{- end }}`. Delete the sms block too, if A0 brought it in.
  3. In `deployment.yaml`, delete the matching `items` entries.
  4. In `fetch-configs.sh`, delete the "per-network email copy" section, and the sms section if present. In its place, clear any leftover files from earlier deploys, so a stale file cannot resurrect a delivery the chart no longer has:

```bash
    rm -rf "$REPO_ROOT/helm/signals/charts/api/files/messages" "$REPO_ROOT/helm/signals/charts/api/files/sms"
```

  5. Update the header comment lines 15–16 and 33–35 that list `messages.properties`.
  6. In `helm/CLAUDE.md`, replace the two sections with one paragraph: email and SMS copy live in notification-service (seeded from `ns-catalogue.json`, edited through its admin API), and Signals authenticates to NS with its Keycloak `signals-api` client.

- [ ] **Step 4: Verify.** Run `bash helm/signals/tests/render_test.sh` and the `ci.yml` lint and template commands. Then run `git grep -n "NOTIFICATION_SERVICE_SECRET\|NOTIFICATION_SERVICE_KEY_ID\|notificationKeyId\|NOTIFICATION_FROM_EMAIL\|SMS_TEMPLATE_ID\|files/messages"`. Expected: no hits outside dated docs.

- [ ] **Step 5: Commit.** Message: `refactor(signals): Signals reaches NS with its Keycloak client; copy ConfigMaps removed`

---

### Task A4: The Keycloak chart targets `/v1/notify` and can send email OTP through NS (automation)

**Files:**
- Modify:
  - `helm/keycloak/charts/keycloak/values.yaml`
  - `helm/keycloak/charts/keycloak/templates/configmap.yaml`
  - `helm/keycloak/values.yaml` (comment at :111)
  - `opentofu/aws/modules/output-file/variables.tf` (comment at :176)
  - `dockerfiles/keycloak/providers/README.md`
- Create: `helm/keycloak/tests/render_test.sh`. Add it to the same CI step as Task A1's test.

- [ ] **Step 0: Confirm names.** Read Plan F3's NS client section and record the exact env names in the task report:
  - the email-provider SPI env (expected `KC_SPI_OTP_EMAIL__PROVIDER`, values `smtp` | `http`);
  - the shared NS config env (expected `SMS_HTTP_URL`, `SMS_HTTP_SECRET`, `SMS_HTTP_KEY_ID`, `SMS_HTTP_TIMEOUT_MS`, `SMS_HTTP_TEMPLATE_ID`, `SMS_HTTP_OTP_VAR_NAME`, plus any email template key F3 adds).

  If F3 differs, use F3's names throughout this task.

- [ ] **Step 1: Write the failing test.** Create `helm/keycloak/tests/render_test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CHART="../charts/keycloak"
fail() { echo "FAIL: $*" >&2; exit 1; }
render() { helm template kc "$CHART" --namespace keycloak --show-only templates/configmap.yaml "$@"; }

out="$(render)"
! grep -q 'KC_SPI_OTP_EMAIL__PROVIDER' <<<"$out" || fail "default renders an email OTP provider (smtp is the plugin default)"
grep -q 'SMS_HTTP_URL' <<<"$out" && fail "NS block rendered with nothing on http"

out="$(render --set smsProvider=http)"
grep -q 'SMS_HTTP_URL: "http://signals-notification-service.signals.svc.cluster.local:3000/v1/notify"' <<<"$out" \
  || fail "default NS URL is not /v1/notify"

out="$(render --set otpEmailProvider=http)"
grep -q 'KC_SPI_OTP_EMAIL__PROVIDER: "http"' <<<"$out" || fail "email provider not rendered"
grep -q 'SMS_HTTP_URL' <<<"$out" || fail "email over http needs the NS block"
echo "keycloak render_test: ok"
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: `FAIL: email OTP provider default is not smtp`.

- [ ] **Step 3: Implement.**
  - **`values.yaml`:** add the following beside `smsProvider`. Rename the `smsHttp` comment to "NS connection (SMS and email over http)". The `smsHttp` key name stays, so existing cluster values keep working.

```yaml
# smtp (default): Keycloak sends email OTP through the realm's SMTP server.
# http: posts it to notification-service (/v1/notify, template login_otp, HMAC v2),
# sharing the smsHttp connection below. Flip per cluster only after Plan F3's jar
# is in the image and the cluster's NS catalogue carries the email login_otp template.
otpEmailProvider: smtp
```

  - **`templates/configmap.yaml`:**

```yaml
  KC_SPI_OTP_EMAIL__PROVIDER: "{{ .Values.otpEmailProvider }}"
  {{- if or (eq .Values.smsProvider "http") (eq .Values.otpEmailProvider "http") }}
  SMS_HTTP_URL: "{{ .Values.smsHttp.url | default (printf "http://%s-notification-service.%s.svc.cluster.local:3000/v1/notify" (.Values.global.signalsRelease | default "signals") (.Values.global.signalsNamespace | default "signals")) }}"
  ... (the remaining SMS_HTTP_* lines unchanged)
  {{- end }}
```

  - **The two comments** that say `/notify` and `METHOD\nPATH\nTIMESTAMP\nNONCE` become `/v1/notify` and `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)` (HMAC v2).
  - **providers README:**
    - The source branch is `main`. Delete the "SMS vendor providers live on `enhancements`" note.
    - The `http` provider posts to `/v1/notify` with HMAC v2 from 1.3.0 (Plan F3) on.
    - The email-provider SPI is listed under "What it registers".

- [ ] **Step 4: Verify.** Run `bash helm/keycloak/tests/render_test.sh` and `helm lint helm/keycloak` as `ci.yml` runs it. Expected: pass.

- [ ] **Step 5: Commit.** Message: `feat(keycloak): NS connection targets /v1/notify; email OTP provider is configurable`

- [ ] **Step 6 (gated, after Plan F3's plugin PR merges and its release jar exists):** run the providers README bump procedure:
  - replace the jar with F3's release jar;
  - update the version and `sha256:` line;
  - build the image with `build-keycloak-image.yml`.

  Commit message: `chore(keycloak): OTP plugin <version> (HMAC v2, /v1/notify, email over http)`. The image tag pin per environment is a runbook step.

---

### Task A5: e2e harness — NS sends real mail to Mailpit; Signals uses its token (bluedots-e2e)

**Files:**
- Modify:
  - `src/targets/target_discovery.ts`
  - `src/env/capabilities.ts`
  - `src/env/compose/{ports.ts,compose_provider.ts,overlay.ts,stack_env.ts}`
  - their tests: `overlay.test.ts`, `stack_env.test.ts`, `compose_provider.test.ts`, and the `target_discovery` test.

Read `README.md` and the comments in `overlay.ts` first. That file is a template literal, so never put a backtick in a comment.

**Interfaces:**
- **`ResolvedTarget`** gains:
  - `networkId: string`, the network.json `id`;
  - `cataloguePath: string | null`, `<dir>/ns-catalogue.json` when it exists, else `<dotDir>/ns-catalogue.json`, else `null`.
- **`Capability`** becomes `'http' | 'redis' | 'postgres' | 'mail'`. The compose provider advertises `mail`. The external provider advertises it only when its config declares `endpoints.mailpit`.
- **`Endpoints`** gains `mailpit: string` (`http://localhost:<port>`). `DiscoveredPorts` gains `mailpit` (container port 8025).

- [ ] **Step 1: Write the failing tests.**
  - **`overlay.test.ts`:** the rendered `notification-service` environment contains:
    - `SMTP_HOST: mailpit`, `SMTP_PORT: "1025"`, `SMTP_SECURE: "false"`;
    - `EMAIL_FROM_ADDRESS: notifications@bluedots.test`, `EMAIL_FROM_NAME: "Blue Dots"`;
    - `NS_NETWORK: "<networkId>"`;
    - `NS_SEED_FILE: /app/seed/ns-catalogue.json`, with a volume `<cataloguePath>:/app/seed/ns-catalogue.json:ro`;
    - `NS_KEYCLOAK_ISSUER: "http://localhost:8080/realms/bluedots"`;
    - `NS_KEYCLOAK_JWKS_URI: "http://keycloak:8080/realms/bluedots/protocol/openid-connect/certs"`;
    - `NS_AUTH_ALLOWED_AZP: signals-api`;
    - `SMS_PROVIDER: msg91`, `MSG91_AUTH_KEY: journey-dummy`, `SMS_LOGIN_OTP_TEMPLATE_ID: journey-login-otp`.

    The `MAIL_LOG` line is gone. Also:
    - the `signals-api` environment has no `NOTIFICATION_SERVICE_KEY_ID`, `NOTIFICATION_SERVICE_SECRET` or `NOTIFICATION_FROM_EMAIL`, and has `SUPPORT_EMAIL` and `SUPPORT_CC_EMAIL`;
    - a target with `cataloguePath: null` renders no `NS_SEED_FILE`.
  - **`stack_env.test.ts`:**
    - the HMAC and from-address keys are absent;
    - `SUPPORT_EMAIL: 'support@bluedots.test,ops@bluedots.test'`, `SUPPORT_CC_EMAIL: 'cc@bluedots.test'`;
    - `CREATE_TEST_OTP` is unset or false, so guardian OTPs are really sent.
  - **The target test:** `blue_dot/ka-dhwd` resolves `networkId` and `cataloguePath` from `tests/fixtures/schemas`. Add a fixture `tests/fixtures/schemas/blue_dot/ka-dhwd/ns-catalogue.json` with content `{"version":"fx","templates":[],"policies":[]}`.
  - **`compose_provider.test.ts`:**
    - `assertBindSources` receives `cataloguePath` when it is non-null;
    - `endpoints.mailpit` comes from `docker compose port mailpit 8025`;
    - the provider's capabilities include `mail`.

- [ ] **Step 2: Run and confirm they fail.** Run `pnpm test`.

- [ ] **Step 3: Implement.**
  - **`target_discovery.ts`:** read `config.id` into `networkId`, and use `firstExisting(join(dir,'ns-catalogue.json'), join(dotDir,'ns-catalogue.json'))`.
  - **`overlay.ts`:**
    - Replace the NS comment's "Delivery itself needs SES or Gmail" paragraph with "NS sends real SMTP to the stack's mailpit; journeys read delivered mail over Mailpit's API."
    - Set the env listed in Step 1.
    - Mount the catalogue file read-only.
    - Add `keycloak: condition: service_healthy` to NS `depends_on` if the base defines a Keycloak healthcheck. Otherwise leave it out: NS fetches JWKS lazily, at the first bearer request.
    - In `signals-api`, delete the three notification lines and their comment, and add the two support lines.
  - **`stack_env.ts`:** delete `NOTIFICATION_KEY_ID` / `NOTIFICATION_SECRET` from the Signals env, plus the comment block that justifies them. Keep the generated internal-secrets file: NS requires `INTERNAL_SECRETS_JSON` at boot, and the file may keep its key.
  - **`ports.ts` / `compose_provider.ts`:** add the mailpit port and endpoint. Advertise `mail`.

- [ ] **Step 4: Run.** Run `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit.** Message: `feat(compose): notification-service delivers to mailpit and seeds the target's catalogue`

---

### Task A6: Assert delivered mail through Mailpit; move J11–J13 over (bluedots-e2e)

**Files:**
- Create: `src/awaiters/mail.ts`, `src/awaiters/mail_probe.ts`, `src/awaiters/mail.test.ts`, `src/steps/projections/email_delivered.ts`
- Modify:
  - `src/journey/{define_journey.ts,state.ts}` (`ctx.mail`, `state.mailBaseline`)
  - the actors that captured `notificationBaseline` (`create_profile`, `change_lifecycle`, `create_profile_as_self`, `edit_profile`)
  - `src/steps/index.ts`, `tests/stack/boot_stack.ts`
  - `journeys/notifications/{onboarding_notifies_the_participant,pausing_notifies_the_owner,retiring_notifies_the_owner}.ts`
- Delete: `src/awaiters/notification.ts`, `notification_probe.ts`, `notification.test.ts`, `src/steps/projections/notification_queued.ts`

**Interfaces:**

```ts
// src/awaiters/mail.ts
export type MailSummary = { id: string; to: string[]; cc: string[]; subject: string; created: string };
export type MailMessage = MailSummary & { html: string; text: string; replyTo: string[]; from: string };
export type MailProbe = {
  /** Every message Mailpit holds (newest first), or null when Mailpit cannot be read. */
  list: () => Promise<MailSummary[] | null>;
  get: (id: string) => Promise<MailMessage | null>;
};
export type MailBaseline = { ids: Set<string> };
export async function captureMailBaseline(probe: MailProbe): Promise<MailBaseline>;
export type MailMatch = { to: string; subjectIncludes?: string; bodyIncludes?: string[]; cc?: string[]; replyTo?: string };
export async function awaitEmailDelivered(
  probe: MailProbe, match: MailMatch,
  opts: { baseline: MailBaseline; deadlineMs: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<MailMessage>;
// src/awaiters/mail_probe.ts
export function createMailProbe(cfg: { baseUrl: string; fetchImpl?: typeof fetch }): MailProbe;
```

- **The Mailpit API:**
  - `GET /api/v1/messages?limit=1000` returns `{messages:[{ID, To:[{Address}], Cc:[{Address}], Subject, Created}]}`.
  - `GET /api/v1/message/{ID}` returns `{ID, From:{Address}, To, Cc, ReplyTo:[{Address}], Subject, HTML, Text}`.
- **Matching:**
  - Addresses compare case-insensitively.
  - Only ids absent from the baseline count.
  - `bodyIncludes` strings must all appear in `HTML` or `Text`.
- **The error on deadline** is `EMAIL_NOT_DELIVERED after <ms>ms: <last reading>`, ending "signals-dpg sends best-effort; check the signals-api log for ns_rejected/ns_unreachable, then the notification-service log."

- [ ] **Step 1: Write the failing tests** in `mail.test.ts`, with a fake probe and fake clock:
  - a message present in the baseline never matches;
  - a fresh message to another address does not match, and the deadline error names what was seen (subject → to);
  - `subjectIncludes`, `bodyIncludes`, `cc` and `replyTo` must all hold;
  - `list()` returning null is retried until the deadline. It is never read as "nothing yet" forever: the error says Mailpit could not be read;
  - `captureMailBaseline` throws `MAIL_PROBE_UNREADABLE` on a null list.

  `mail_probe` gets one test with a stubbed `fetch`, mapping the two Mailpit JSON shapes above.

- [ ] **Step 2: Run and confirm FAIL.**

- [ ] **Step 3: Implement.**
  - **The awaiter** follows the polling shape of the deleted `awaitNotificationQueued`. The default deadline is 30 s, because SMTP to Mailpit plus the NS worker are slower than a Redis read.
  - **Step `expectEmailDelivered`:**

```ts
export const expectEmailDelivered = (spec: {
  /** Who it is for: a profile key, or 'signedUp' / 'support' / 'guardian'. */
  to: { profile: string } | { signedUp: true } | { address: string };
  about: string;                       // business words for the report, never a template key
  subjectIncludes?: string;
  bodyIncludes?: string[];
  cc?: string[];
  replyTo?: string;
  deadlineMs?: number;
}) => step({ label: `Emailed ${...} about ${spec.about}`, run: async (ctx) => { ... } });
```

    It resolves the address (profile email, `state.signedUp.email`, or the literal), reads `state.mailBaseline`, and calls `awaitEmailDelivered`.
  - **Actors:** every actor that set `state.notificationBaseline` now sets `state.mailBaseline = await captureMailBaseline(ctx.mail)` when `ctx.mail` is present.
  - **`boot_stack.ts`:** `mail: createMailProbe({ baseUrl: env.endpoints.mailpit })` replaces the notification probe.
  - **J11–J13:**
    - `expectNotificationQueued({..., templateIdIncludes})` becomes `expectEmailDelivered({ to: { profile: 'seeker' }, about, subjectIncludes })`.
    - Take the subject substring from the generated catalogue for the journey's target. Read `bluedots-schemas/<target>/ns-catalogue.json` and pick a word stable across both targets: the template's `subject` for `account.aggregator_init.seeker`, `profile.pause` or `profile.retire`.
    - `requires` becomes `['http', 'mail'] as const`.
    - Rewrite the header comments: assert the delivered email, not the queue.

- [ ] **Step 4: Run.**
  1. `pnpm test`.
  2. `pnpm test:stack` for J11–J13 against a local stack that has these images: NS from the stacked branch, Signals from `feat/ns-v1-notify`, and the aggregator realm from `feat/ns-keycloak-client`.

  Expected: green, with the evidence sheet showing the delivered subject.

- [ ] **Step 5: Commit.** Message: `feat(journeys): notifications are asserted as delivered mail, not queued jobs`

---

### Task A7: Journeys for the F2 event table (bluedots-e2e)

**Files:**
- Create:
  - `journeys/notifications/{a_request_emails_the_provider,a_guardian_is_emailed_a_code,a_new_person_is_welcomed,a_support_request_reaches_the_team}.ts`
  - actors `src/steps/actors/{submit_support_request,record_age,name_a_guardian}.ts`
- Modify: `src/steps/index.ts`, `journeys/index.ts`

| Id | Journey | Steps | Assertion |
|---|---|---|---|
| J21 | A request emails the provider | `createProfile provider`, `createProfile seeker`, `applyTo apply seeker→provider` | provider gets the `action.apply.inbound_request` mail (subject word from the catalogue; body contains the seeker's display name) |
| J22 | A guardian is emailed a code | `signUp seeker`, `recordAge 15`, `nameAGuardian {guardianEmail: journey-guardian-<seed>@example.test}` | the guardian address gets `guardian.account`; the body matches `/\b\d{6}\b/`; the subject comes from the catalogue |
| J23 | A new person is welcomed | `signUp seeker` | the signed-up address gets the `welcome.seeker` (or `welcome`) mail with a link to `FRONTEND_BASE_URL` |
| J24 | A support request reaches the team | `signUp seeker`, `submitSupportRequest {type, details}` | `to: support@bluedots.test`, `cc` ⊇ `[ops@bluedots.test, cc@bluedots.test]`, `replyTo` = the submitter, body contains the returned reference |

Targets are `['purple_dot/alimco', 'blue_dot/ka-dhwd']`, matching J11–J13. J22 runs on a target whose catalogue has the guardian policies, which is all of them. Every journey `requires: ['http', 'mail']`.

- **Actor routes**, all as the signed-up participant. Read `create_profile_as_self.ts` and `respond_to_request.ts` for how a step acts as a participant, and the schemas in signals-dpg `packages/schemas/src/u18_consent.ts`.
  - `recordAge`: the age route in `apps/api/src/routes/v1/consent/` (`U18DobBodySchema`, `{age}`).
  - `nameAGuardian`: `POST /api/v1/consent/u18/guardian` with `{network, guardianName, guardianEmail, guardianDeclarationAccepted: true}`.
  - `submitSupportRequest`: `POST /api/v1/support`, with the body from `submit_support.ts`'s schema. Store the returned reference in state as `supportReference`.
  - Each actor captures `mailBaseline` before its request.
- **The OTP** is matched by shape only. It is never printed in the evidence sheet: the step label says "a 6-digit code" and the matched text is not logged.

- [ ] **Step 1: Write the journeys and actor tests.** Use the repo's existing actor test pattern for request shape, with a stubbed http. The journeys themselves are exercised by the stack test.
- [ ] **Step 2: Run `pnpm test` and confirm the actor tests fail.**
- [ ] **Step 3: Implement the actors and register the journeys.**
- [ ] **Step 4: Run.** Run `pnpm test`, then `pnpm test:stack` with the same images as A6. Expected: J21–J24 green on both targets.
- [ ] **Step 5: Commit.** Message: `feat(journeys): action, guardian, welcome and support emails`

---

## Rollout runbook (Part A release)

Each cluster's values live in bluedots-infra-deployments, which is private and partly Ansible-Vault encrypted (ALIMCO-TCS). Edit them there, never in this plan's PRs.

**Per cluster, before the release is applied:**

Every cluster's own `global-values.yaml` was copied from the template, so add these under `notification-service.config` in each one (the chart refuses to render without a From address):

```yaml
EMAIL_FROM_ADDRESS: *smtp_user
EMAIL_FROM_NAME: *smtp_from_display   # up-sdm: "UP SDM"
```


| Cluster | Catalogue | Before the first boot with `NS_SEED_FILE` |
|---|---|---|
| Ekstep-blue-dots-dev | `blue_dot/` | `msg91_template_id` set → `SMS_LOGIN_OTP_TEMPLATE_ID` |
| Ekstep-purple-dots-dev | `purple_dot/` | same |
| Ka-dhwd-blue-dots-prod | `blue_dot/ka-dhwd/` | same |
| Ontac-orange-dots-prod | `orange_dot/onetac/` | same |
| up-gzb-blue-dots-prod | `blue_dot/up-gzb/` | same |
| up-sdm-blue-dots-prod | `blue_dot/upsdm/` | same; `EMAIL_FROM_NAME: "UP SDM"` as a literal (Keycloak keeps "Aggregator") |
| Test-dev | `blue_dot/up-gzb/` | add `msg91_template_id` (or Pinnacle settings) and `sms_http_secret`; both are unset today. Its `notification-service` block also needs an email transport: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` |
| ALIMCO-TCS | `purple_dot/alimco/` | decrypt and confirm the vendor and `_brand: "alimco"` (a brand is required to fetch its catalogue); for Pinnacle, set `pinnacle_login_otp_template_id` and `sms_login_otp_body`; confirm `keycloak.smsProvider` is not `http` (or pin `smsHttp.url` to the legacy path until the F3 jar ships) |

**Every cluster, also:**
- **Operator key (ruling R8).** Each cluster gets an `ns-admin` HMAC key with scope `templates:admin`. Order: `bash install.sh apply_tf_random_passwords` (or `create_tf_resources`) creates `random_id.ns_admin_secret`; then `apply_tf_output_file`; then deploy signals (NS restarts once). If the output file is rendered before the password exists, the entry renders blank and NS skips it. Read the key with `kubectl -n signals get secret signals-notification-service-internal -o jsonpath='{.data.internal-secrets\.json}' | base64 -d | jq -r '."ns-admin".secret'`, and call the admin API with `X-NS-Key: ns-admin` and an HMAC v2 signature (NS README, Admin API). ALIMCO-TCS: add the entry by hand.
- **Keycloak.** Confirm `keycloak.smsProvider` is not `http` and `otpEmailProvider` is unset or `smtp`. The chart's default NS URL is now `/v1/notify`, which only the F3 jar speaks.
- **Test-dev From name.** Its `_smtp_from_display` is "blue Dots"; set `EMAIL_FROM_NAME: "Blue Dots"` as a literal.

**Apply order:**
1. Common-services / RDS bootstrap for NS Postgres (automation#260 checklist).
2. The realm grant: `signals-api` gets the `notification-service` role `notify:send` (aggregator-dpg#834 realm, automation#262 reconcile). Confirm a `client_credentials` token for `signals-api` carries `aud: notification-service`.
3. The signals umbrella release, with these image tags: NS Stage 1 (with #156) and Signals (with #792). Preconditions:
   - bluedots-schemas#47 is on `main` (or the fetch ref is pinned to a commit that has the catalogues);
   - the deploy host has `jq`.

   Run `fetch-configs.sh signals` first; it fetches and validates the catalogue. During the upgrade, Signals pods can start before the new NS pod is Ready; a few best-effort sends in that window are refused (Signals logs `ns_rejected` / `ns_unreachable`). Check the logs once the rollout completes.
4. Verify:
   - NS logs `catalogue <version> seeded: {...}` with no `seeded_draft` for guardian policies;
   - `GET /v1/admin/export`, signed with the `ns-admin` key, lists the policies;
   - one action email, one welcome and one support email arrive, plus one guardian OTP to an email contact;
   - Signals logs show no `ns_rejected` or `ns_unreachable`.
5. Keycloak stays on today's `smsProvider` and `otpEmailProvider: smtp`. The flip to `http` is Plan G.

**Recovery: guardian policies seeded as drafts** (`login_otp` was configured after the first boot). Publish each draft through `POST /v1/admin/policies/:id/publish`, signed with the `ns-admin` key.

**Part B release gate.** Merge Part B for the next release only when all of these hold:
- every cluster above runs the Signals image with #792;
- the F3 jar is in the automation Keycloak image (providers README sha256 updated), and no Keycloak on any cluster runs an older jar with `smsProvider: http` or `otpEmailProvider: http` (the older jar signs v1, which Part B rejects);
- 24 h have passed since the last cluster upgraded, which is the recovery window;
- each cluster's NS DLQ holds no legacy job awaiting replay. `GET /metrics/queue` gives the depth; a legacy entry in `queue:dlq` is one with no `v1` field. Part B dead-letters any that remain as `legacy_job_shape`, so this check is about not losing a replayable send, not about safety.

---

# Part B — the next release

### Task B1: The worker handles only v1 jobs (notification-service)

**Files:**
- Modify: `src/lib/worker.ts`, `src/types/index.ts`, `src/lib/__tests__/worker.test.ts`

**Interfaces:**
- `Job` keeps `job_id`, `channel`, `priority`, `to`, `attempt`, the deadline fields, `v1` and the audit ids.
- `template_id`, `variables` and `body` go, together with `NotifyRequest`.
- `processJob(job)`: when `!job.v1`, it dead-letters with reason `legacy_job_shape` and returns. Otherwise it runs `processV1Job`, unchanged.

- [ ] **Step 1: Write the failing test** in `worker.test.ts`: "a job with no v1 plan is dead-lettered as legacy_job_shape".
  - Input: `{job_id:'j1', channel:'sms', priority:'other', to:'+911234567890', template_id:'login_otp', variables:{message:'1'}}`.
  - Expect `moveToDeadLetter` with reason `legacy_job_shape`, no provider call, and `ns_job_dlq_total` incremented with `{channel:'sms', reason:'legacy_job_shape'}`.
  - Delete the legacy-shape describes (:173–538), keeping the v1 suites (:637 on).
- [ ] **Step 2: Run and confirm FAIL.**
- [ ] **Step 3: Implement.** Replace `processJob`'s legacy body (lines 102–210) with the guard, reusing `dropOrDeadLetter(job, 'legacy_job_shape')` so the metric and audit stamping stay identical.
- [ ] **Step 4: Run.** `pnpm build && pnpm test`, then `pnpm test:integration`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `refactor(worker): only Send API v1 jobs are processed; legacy-shaped jobs are dead-lettered`

### Task B2: Remove legacy `/notify` and HMAC v1 (notification-service)

**Files:**
- Delete:
  - `src/routes/notify.ts`, `src/routes/__tests__/notify.test.ts`
  - `src/lib/dedupe_key.ts`, `src/lib/__tests__/dedupe_key.test.ts`
- Modify:
  - `src/app.ts`
  - `src/plugins/auth.ts` (the `legacyHmacV1` option)
  - `src/lib/auth/hmac.ts` (accept `v2=` only; drop the v1 canonical branch)
  - `src/plugins/__tests__/auth.test.ts`, `src/lib/auth/__tests__/hmac.test.ts`, `src/__tests__/route-scopes.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `POST /notify` answers 404.
  - A `v1=` signature on `/v1/notify` answers 401 with the same body as any bad signature.
  - `hmac.test.ts`: the signature regex accepts `v2=<64 hex>` only.
  - Remove the v1 positive cases.
  - `route-scopes.test.ts` no longer lists `/notify`.
- [ ] **Step 2: Run and confirm FAIL.**
- [ ] **Step 3: Implement.**
  - Delete the files.
  - Unregister the route in `app.ts`.
  - Remove the `legacyHmacV1` option and its branch.
  - The signature regex becomes `^v2=([0-9a-f]{64})$`, and the canonical string always appends `bodyDigest(body)`.
  - Keep `src/lib/dedupe.ts`, which `/v1/notify` uses.
- [ ] **Step 4: Run.** `pnpm build && pnpm test && pnpm test:integration`.
- [ ] **Step 5: Commit.** Message: `refactor: remove legacy /notify and HMAC v1`

### Task B3: Provider definitions lose their legacy fields (notification-service)

**Files:**
- Modify:
  - `src/types/provider.ts`
  - `src/lib/providers/{email/mailer.ts,email/sendMailCore.ts,sms/msg91.ts,sms/pinnacle.ts,whatsapp/twilio.ts}`
  - `src/lib/templates/seed.ts`
  - `src/routes/providers.ts`, `src/lib/utils/provider-docs.ts`
  - their tests

**Interfaces:**
- **`ProviderDefinition`** becomes `{ name; vendor; renders; sendRendered(args): Promise<ProviderSendResult>; balance?... }`. `sendRendered` becomes required. `templates`, `bodies`, `allowRawTemplateId`, `schema` and `send` go. `ProviderSendArgs` goes.
- **`seed.ts` `configuredLoginOtp()`** returns `{ id: string; body: string | null } | undefined`:
  - msg91: `SMS_LOGIN_OTP_TEMPLATE_ID`, body `null`;
  - pinnacle: `PINNACLE_LOGIN_OTP_TEMPLATE_ID`, body `SMS_LOGIN_OTP_BODY`.

  Blank values are treated as unset, giving `skipped_no_id`.
- **`GET /providers`** returns `[{name, vendor, renders}]`, and `/providers/:name` returns one entry (F4-12).

- [ ] **Step 1: Write the failing tests.**
  - **`seed.test.ts`:**
    - msg91 with only `SMS_LOGIN_OTP_TEMPLATE_ID` seeds that id with no body;
    - pinnacle seeds the id with `SMS_LOGIN_OTP_BODY`;
    - pinnacle with no body seeds a draft (`seeded_draft`), as today;
    - nothing set gives `skipped_no_id`.
  - **providers route test:** the shape is `{name, vendor, renders}`.
  - **mailer:** `basic_email` is gone; a v1 email still sends.
  - **twilio:** no `other` passthrough.
  - **msg91:** the legacy `send` is gone; `sendRendered` keeps the `message` → `var` mapping.
- [ ] **Step 2: Run and confirm FAIL.**
- [ ] **Step 3: Implement** to the interfaces. `sendMailCore` drops the html-only legacy path and keeps `html` and/or `text`. Delete msg91's hardcoded fallback flow id.
- [ ] **Step 4: Run.** `pnpm build && pnpm test && pnpm test:integration`.
- [ ] **Step 5: Commit.** Message: `refactor(providers): providers send rendered content only; login_otp seeds from explicit env`

### Task B4: Docs (notification-service)

**Files:** `README.md`, `CLAUDE.md`, `example.env`, `src/lib/utils/openapi.ts`, `src/lib/utils/__tests__/openapi.test.ts`

- [ ] **Step 1: Failing test.** In `openapi.test.ts`, the document has no `/notify` path and no `v1=` signature description, and `/providers` documents `{name, vendor, renders}`.
- [ ] **Step 2: Implement.**
  - **OpenAPI:** remove `:541–647` and the `/notify` mentions at `:486` and `:816`.
  - **README:** remove "Queue A Notification", "Email Attachments" (legacy form), the old "Provider Discovery" body, "Request Examples", "SMS Templates & Variables", the dedupe notes and the v1 signing section.
    - Keep and refresh "Adding A Provider": `sendRendered` only.
    - The auth section describes bearer and HMAC v2.
  - **CLAUDE.md:** rewrite the overview, signing, Provider System, Request Deduplication and route-table sections to the v1-only service. Delete "stays until the cutover release". Update the test counts.
  - **`example.env`:** drop legacy-only keys and keep `SMS_LOGIN_OTP_*` / `PINNACLE_*`.
- [ ] **Step 3: Run.** `pnpm build && pnpm test`, then `git grep -n "legacyHmacV1\|/notify\b\|basic_email\|dedupe_id\|allowRawTemplateId"`. Expected: no hits outside `docs/superpowers` and `CHANGELOG`.
- [ ] **Step 4: Commit.** Message: `docs: notification-service serves Send API v1 only`

### Task B5: Drop the legacy HMAC key from the deployment (automation)

**Files:**
- tfpl: remove the `dpg-api-client` entry from the NS internal-secrets JSON.
- `helm/signals/values.yaml`: remove the same entry from the default internal-secrets JSON, if present.
- `opentofu/aws/modules/random_passwords/main.tf` (`signals_notification_secret`).
- `opentofu/aws/_common/output-file.hcl` (`:106`, `:157`).
- `helm/signals/tests/render_test.sh`: flip the A3 assertion to "no `dpg-api-client`".
- `helm/CLAUDE.md`: remove the "three settings stay one more release" paragraph.
- **Signals' half of the legacy key (kept in Part A by ruling R4, for rollout restarts and rollback):**
  - `helm/signals/values.yaml`: the `notificationKeyId`/`notificationSecret` anchors, the `NOTIFICATION_SERVICE_KEY_ID`/`NOTIFICATION_SERVICE_SECRET` data keys, and the `internalSecrets` comment about `notificationSecret`;
  - `helm/signals/charts/api/values.yaml`: `NOTIFICATION_SERVICE_KEY_ID`/`NOTIFICATION_SERVICE_SECRET`;
  - `opentofu/aws/template/global-values.yaml`: `notificationKeyId` and `api.config.NOTIFICATION_FROM_EMAIL`;
  - tfpl: `notificationSecret` and `NOTIFICATION_SERVICE_SECRET`.
- Runbook for this release, per cluster, once the release gate holds:
  1. Remove from the cluster's own `global-values.yaml`: `api.secrets.notificationKeyId`, `api.config.NOTIFICATION_FROM_EMAIL`, and `global.signals_notification_secret_bytes` if set.
  2. Regenerate secrets with `bash install.sh apply_tf_output_file`. A full `create_tf_resources` (or a `random_passwords` apply) also destroys `random_id.signals_notification_secret`; that is expected.
  3. ALIMCO-TCS (hand-maintained, encrypted secrets): remove `api.secrets.notificationSecret`, `api.secrets.data.NOTIFICATION_SERVICE_SECRET` and the `dpg-api-client` entry in `notification-service.internalSecrets.json` by hand. Keep `keycloak` and `ns-admin`.
  4. Deploy signals.

- [ ] **Step 1:** Flip the A3 assertions (the "present until Part B" block and `dpg-api-client`) to "absent", then run them and confirm FAIL.
- [ ] **Step 2:** Remove the entry, Signals' half listed above, the random password and its two references.
- [ ] **Step 3:** Run `tofu validate` on a cluster module as the repo's CI does, then `render_test.sh`, `helm lint` and `helm template`. Expected: pass.
- [ ] **Step 4: Commit.** Message: `chore(ns): retire the legacy Signals HMAC key`

---

## Merge order

**Part A (Stage 1 release):**
1. bluedots-schemas#47 → `main` (the catalogue fetch and e2e CI read it).
2. notification-service Stage 1 stack #147 … #156 into `feature`; #156 carries A8.
3. signals-dpg#792 into `feature`.
4. Realm grant: aggregator-dpg#834 and bluedots-automation#262.
5. bluedots-automation #260 → #263, then `feat/ns-cutover-wiring`. Before this, sync automation `main` down into `feature` (main carries #268, which touches `helm/CLAUDE.md`).
6. bluedots-e2e #40 → #41, then `feat/ns-mailpit-e2e`.
7. Promote, cut the RC tag, pin images per cluster, run the runbook.

Work→feature PRs squash-merge, so each stacked branch is rebased onto `origin/feature` once the branch below it lands (`git rebase --onto origin/feature <old-base>`).

**Out of band, before Part B:** the F3 Keycloak plugin PR → `main`, then the A4 jar bump and a Keycloak image build.

**Part B (next release, after the gate):** notification-service `feat/ns-legacy-removal` and bluedots-automation `feat/ns-legacy-key-removal`, each rebased onto `feature`. They do not depend on each other; ship both in the same release.

## Done when

**Part A**
- automation: `render_test.sh` (signals and keycloak), `helm lint`, the CI `helm template` step and the promtool tests are green. A real `fetch-configs.sh signals` run writes the right catalogue for a brand cluster and for a network cluster.
- No Signals chart or template renders `SMS_TEMPLATE_ID` or `messages.properties`. The Signals HMAC pair and `NOTIFICATION_FROM_EMAIL` still render, and NS internal-secrets still holds `dpg-api-client` (ruling R4: the previous Signals image needs them on rollout restarts and rollback). NS internal-secrets also holds `keycloak` and `ns-admin`.
- NS renders `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` and, when the catalogue was fetched, `NS_SEED_FILE`, and refuses to render without a From address.
- The Keycloak chart defaults the NS URL to `/v1/notify` and can render `otpEmailProvider: http`. The jar bump is done once F3's jar exists.
- e2e: `pnpm test` is green. `pnpm test:stack` runs J11, J12, J14 and J21–J26 green on `purple_dot/alimco` and `blue_dot/ka-dhwd` (J21 and J26 on ka-dhwd, J25 on alimco), each asserting a delivered Mailpit message and the recorded NS event. Nothing reads NS Redis.
- The runbook is attached to the automation PR body.

**Part B**
- notification-service: `pnpm build`, `pnpm test` and `pnpm test:integration` are green. `POST /notify` is 404. HMAC accepts only `v2=`. A legacy-shaped job is dead-lettered as `legacy_job_shape`. Providers expose `sendRendered` only. `login_otp` seeds from explicit env. The docs describe a v1-only service.
- automation: the `dpg-api-client` key, `signals_notification_secret` and Signals' HMAC pair and `NOTIFICATION_FROM_EMAIL` are gone; `keycloak` and `ns-admin` stay; every render and validate check is green.
- It is merged only after the Part B release gate holds.

## Follow-ups owned elsewhere

- **Plan G:** per-cluster flip of Keycloak SMS and email OTP to `http`.
- **Plan F3:** the email `login_otp` template in the catalogues, which A4's `otpEmailProvider: http` depends on.

---

## User decisions (2026-10-06)

- **A0:** rebase the automation NS stack (#260 → #261 → #262 → #263) onto `main` and force-push each branch. The user approved this. The new F4 branch is cut from the rebased `feat/ns-content-resolver`.
- **up-sdm From name:** `EMAIL_FROM_NAME` is `UP SDM` on up-sdm-blue-dots-prod. This overrides that cluster's `_smtp_from_display` ("Aggregator") for NS email only. It is set in the cluster values as a runbook step.
