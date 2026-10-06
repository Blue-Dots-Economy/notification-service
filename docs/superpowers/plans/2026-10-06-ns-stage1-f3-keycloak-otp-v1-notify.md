# NS Stage 1 Plan F3 — Keycloak Login OTP over `/v1/notify` (SMS and Email)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Keycloak OTP plugin hands every login OTP — SMS and email — to notification-service `POST /v1/notify`, signed with HMAC v2. Keycloak still generates and verifies the code; NS only delivers it.

**Architecture:**
- **One NS client.** A new `NsNotifyClient` in the plugin's `common` module owns the HTTP call, HMAC v2 signing (`METHOD\npath\ntimestamp\nnonce\nsha256(body)`) and the "was it accepted" rule. Both channels use it, with one set of settings (`SMS_HTTP_*`).
- **SMS.** The existing `http` SMS provider (`HttpSmsProviderFactory`) moves from legacy `/notify` + v1 to `/v1/notify` + v2, sends `template_key: login_otp`, and canonicalises the phone to E.164 first.
- **Email.** A new `otp-email` SPI (`OtpEmailSender`) replaces the three direct `EmailTemplateProvider` calls. Provider `smtp` (default) is today's behaviour, moved unchanged. Provider `http` sends `template_key: login_otp`, `channel: email` to NS. Selected per cluster with `KC_SPI_OTP_EMAIL_PROVIDER`, like `KC_SPI_SMS_PROVIDER`.
- **Email copy in NS.** The catalogue generator (signals-dpg `tools/ns-catalogue`) gains an email `login_otp` template, ported from the deployed Keycloak theme with each network's sign-off. The nine bluedots-schemas catalogues are regenerated.

**Tech Stack:**
- keycloak-otp-authenticator: Java 17, Maven multi-module, Keycloak SPI 26.7.3 (the runtime version), JUnit 5.10 + Mockito 5.11 + Hamcrest 2.2, libphonenumber.
- signals-dpg `tools/ns-catalogue`: TypeScript, vitest.
- bluedots-schemas: JSON.
- Target API: notification-service `/v1/notify` (Plans C2, D), HMAC v2 (Plan D).

**Tasks:** Tasks 0–4 are keycloak-otp-authenticator; Task 5 is signals-dpg; Task 6 is bluedots-schemas.

**Spec:** notification-service `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04), §Stages item 9 ("Keycloak plugin: HMAC v2, `/v1/notify`, `template_key: login_otp`, email OTP over `http`"). OTP ownership: login OTP is generated and verified in Keycloak (decided 2026-10-06).

**Plan F context:**
- F1 (NS catalogue seed and export) is NS#155. F2 (Signals events) is signals-dpg#792, NS#156, bluedots-schemas#47.
- F3 is this plan.
- F4 covers e2e, the automation chart (including the Keycloak jar bump and chart env for this plan) and NS legacy `/notify` removal, in the release after Stage 1.
- Plan G (per-cluster flip of Keycloak SMS/email to `http`) is deferred.

## Global Constraints

- **Keycloak owns the code.** Generation, storage (auth-session notes / `SingleUseObjectProvider`), TTL, retries and verification are unchanged. The plugin sends only the code, as `variables.message`.
- **Request shape (both channels).** `Content-Type: application/json`; body exactly:
  - SMS: `{"template_key":"login_otp","channel":"sms","to":{"phone":"<E.164>"},"variables":{"message":"<code>"},"priority":"urgent"}`
  - Email: `{"template_key":"login_otp","channel":"email","to":{"email":"<address>"},"variables":{"message":"<code>"},"priority":"urgent"}`
  - No `idempotency_key`; every login mints a new code.
  - `template_key` and the variable name stay configurable (`template-id` / `SMS_HTTP_TEMPLATE_ID`, `otp-var-name` / `SMS_HTTP_OTP_VAR_NAME`).
- **HMAC v2.** Headers `X-NS-Key`, `X-NS-Timestamp` (unix seconds), `X-NS-Nonce` (32 hex chars), `X-NS-Signature: v2=<hex>`. Canonical string `POST\n<path[?query]>\n<timestamp>\n<nonce>\n<sha256 hex of the exact body bytes sent>`. NS reference: `src/lib/auth/hmac.ts` (`canonicalString`, `signHmac`).
- **Accepted means:** any 2xx (NS answers `202` for a new send, `200` for a replay), or `409` whose JSON `error` (or `reason`) is `duplicate-fallback`. Every other status, or an I/O error, fails the send.
- **Logging.** Never log the OTP or a full phone number or email address. Phones go through `SmsLogSafe.maskPhone`; emails are not logged. Response bodies only through `SmsLogSafe.boundedResponse`.
- **Failure surface unchanged.** SMS failures stay `SmsException` → `smsSendError`. Email failures become `OtpEmailException`, caught where `EmailException` is caught today → `emailSendError`. The grant types keep throwing out of `sendOtp`.
- **Defaults unchanged.** With no new configuration a cluster behaves exactly as today: `KC_SPI_SMS_PROVIDER` is whatever it is (all live clusters: `msg91`), and email goes through `smtp`.
- **Keycloak version.** The plugin compiles against the version the deployed image runs (26.7.3), added during execution as Task 4b. The pom and the dev Dockerfile move together with the runtime.
- **Standing rules.**
  - Public repos: state rules positively, no failure narratives.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never run `vitest --root /`. Never use a bare `git stash`.
  - Nothing is pushed without approval.
- **Branches.**
  - keycloak-otp-authenticator: `feat/ns-v1-notify` off `main` (this repo has no `feature` branch); PR into `main`.
  - signals-dpg: a new commit on `feat/ns-v1-notify` (open PR #792), worktree `.worktrees/ns-plan-f2/signals-dpg`.
  - bluedots-schemas: a new commit on `feat/ns-catalogues` (open PR #47, base `main`), worktree `.worktrees/ns-plan-f2/bluedots-schemas`.

### Rulings made while writing this plan

- **F3-1 — Branch from `main`.** keycloak-otp-authenticator has only `main` (and the merged `enhancements`). Work branches from `main` and PRs into `main`.
- **F3-2 — Fix CI first.** `.github/workflows/ci.yml` on `main` lost its line breaks when the action SHAs were pinned (44b3dea): step names and `with:` keys were folded into comments. Task 0 restores the structure from `origin/enhancements` and keeps the 44b3dea SHA pins, so every later task has a green CI.
- **F3-3 — One NS client, v2 only.** `NsNotifyClient` signs v2 only. NS accepts v2 on `/v1/notify`; v1 is accepted only on legacy `/notify`, which this plugin stops calling.
- **F3-4 — One configuration for both channels.** The client reads `url`, `secret`, `key-id`, `timeout-ms` from its SPI scope first, then the existing env names `SMS_HTTP_URL`, `SMS_HTTP_SECRET`, `SMS_HTTP_KEY_ID`, `SMS_HTTP_TIMEOUT_MS`. The email `http` provider reads the same env names, so a cluster configures NS once. `SMS_HTTP_URL` now names the full `/v1/notify` URL.
- **F3-5 — E.164 before sending.** The SMS provider canonicalises with `IdentifierUtil.canonicalize(session, phone)` (region from the realm attribute `phoneDefaultRegion`, else the realm locale, else `IN`). A number that cannot be canonicalised fails with `SmsException` and no request is made.
- **F3-6 — 409 rule.** `duplicate-fallback` (NS saw this exact payload within 5 s) means the code is already on its way: treated as sent. `idempotency_in_progress` cannot occur (no key is sent); any 409 other than `duplicate-fallback` fails.
- **F3-7 — Email SPI with `smtp` as the default.** New SPI `otp-email` (`OtpEmailSenderSpi`, `OtpEmailSender`, `OtpEmailSenderFactory`). `smtp` returns `order() = 100`, `http` returns `0`, so Keycloak picks `smtp` when `KC_SPI_OTP_EMAIL_PROVIDER` is unset.
- **F3-8 — Email `login_otp` lives in the NS catalogue.** It is addressed by `template_key`, so it has no policy. Its only variable is `message` (string, required, sensitive), because `template_key` sends are strict.
- **F3-9 — Email copy is the deployed Keycloak theme.** Subject `OTP to verify access`. HTML body is `emailOtpBodyHtml` and text body is `emailOtpBody` from aggregator-dpg `infra/keycloak/themes/otp/email/messages/messages_en.properties`, with `{0}` → `{{message}}` and `{1}` → the directory's sign-off. The HTML uses Keycloak's base email layout as FreeMarker renders it: `<html lang="en" dir="ltr">\n<body>\n…\n</body>\n</html>\n`, and the text body ends with `\n` (as built in Task 5, byte-identical to the deployed theme).
- **F3-10 — Sign-off per directory** comes from aggregator-dpg `config/<network>[/<brand>]/keycloak.env` `EMAIL_SIGNOFF`. Where a directory sets none, the theme build default `Team EkStep` (`themes.Dockerfile` `ARG EMAIL_SIGNOFF="Team EkStep"`) applies — that is what the theme image bakes for it today.

  | Directory | Sign-off | Source |
  |---|---|---|
  | `blue_dot` | Team EkStep | keycloak.env |
  | `blue_dot/ka-dhwd` | Team EkStep | build default |
  | `blue_dot/up-gzb` | Team EkStep | build default |
  | `blue_dot/upsdm` | Team Blue Dots | keycloak.env |
  | `purple_dot` | Team ALIMCO | keycloak.env |
  | `purple_dot/alimco` | Team ALIMCO | keycloak.env |
  | `yellow_dot` | Team EkStep | build default (no theme config) |
  | `orange_dot` | Team Orange Dots | keycloak.env |
  | `orange_dot/onetac` | Team OneTAC | keycloak.env |

- **F3-11 — Deployment is F4.** Bumping the jar in bluedots-automation, the Keycloak chart (`SMS_HTTP_URL` default `/v1/notify`, `KC_SPI_OTP_EMAIL_PROVIDER`), and the per-cluster flip are out of scope here.

## Review Focus

1. **A phone stored without a country code** (`9876543210`, `+91 98765 43210`) reaches NS as `+919876543210`; one that cannot be parsed (`12345`) fails with no request. → Task 2, `send_canonicalisesPhoneToE164` and `send_rejectsUnparseablePhoneWithoutRequest`.
2. **The digest covers the exact bytes sent**, including escaped and non-ASCII characters: recomputing the signature from the captured request body bytes must match the header. → Task 1, `send_signatureVerifiesAgainstCapturedBodyBytes`.
3. **409 variants:** `duplicate-fallback` → sent; `idempotency_in_progress` or an unparseable 409 body → failure. → Task 1, `send_409DuplicateFallbackIsAccepted`, `send_other409Fails`.
4. **A URL with a query string** signs `path?query`, matching what NS's Fastify `req.url` sees. → Task 1, `signingPath_includesQuery`.
5. **No new configuration keeps today's email path** (`smtp` wins by `order()`), and a user without an email on `http` fails cleanly with no request. → Task 3, `smtpIsDefaultByOrder`; Task 4, `send_userWithoutEmailFailsWithoutRequest`.

---

### Task 0: Restore the CI workflow (keycloak-otp-authenticator)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the branch.**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/keycloak-otp-authenticator
git fetch origin
git switch -c feat/ns-v1-notify origin/main
```

- [ ] **Step 2: Restore the workflow structure.** Take `git show origin/enhancements:.github/workflows/ci.yml` as the layout, and put back the SHA pins from `main` (44b3dea): `actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4`, `actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3  # v4`, `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02  # v4`, and any other pinned action on `main`. Each `- uses:` and each `- name:` is its own list item; each `with:` starts its own line. For example the `build` job reads:

```yaml
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4

      - name: Set up JDK 17
        uses: actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3  # v4
        with:
          java-version: '17'
          distribution: temurin
          cache: maven

      - name: Build and test
        run: mvn clean verify -B

      - name: Upload single JAR
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02  # v4
        with:
          name: keycloak-otp
          path: dist/target/keycloak-otp-*.jar
          if-no-files-found: error
```

  Apply the same fix to `security` and `release`. Keep any other workflow files that 44b3dea added unchanged.

- [ ] **Step 3: Validate.**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); [print(j, [s.get('name') or s.get('uses') for s in d['jobs'][j]['steps']]) for j in d['jobs']]"
mvn -q clean verify -B
```

  Expected: every step prints a name or `uses`, no step has both a `uses` and a `#`-swallowed name, and the Maven build passes. If `actionlint` is installed, run it too.

- [ ] **Step 4: Commit.** `ci: restore the workflow layout after SHA pinning`

---

### Task 1: `NsNotifyClient` — `/v1/notify` with HMAC v2 (common)

**Files:**
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/ns/NsNotifyClient.java`
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/ns/NsNotifyException.java`
- Create: `common/src/test/java/hr/delmisoft/keycloak/otp/ns/NsNotifyClientTest.java`
- Create: `common/src/test/java/hr/delmisoft/keycloak/otp/ns/RequestBodies.java` (test helper)

**Interfaces:**
- Produces:
  - `public static NsNotifyClient NsNotifyClient.fromConfig(org.keycloak.Config.Scope config)` — reads `url`/`SMS_HTTP_URL`, `secret`/`SMS_HTTP_SECRET`, `key-id`/`SMS_HTTP_KEY_ID` (default `keycloak`), `timeout-ms`/`SMS_HTTP_TIMEOUT_MS` (default 5000); never throws.
  - `NsNotifyClient(HttpClient http, URI uri, String keyId, String secret, long timeoutMs)` (package-private, for tests).
  - `public boolean isConfigured()` — `uri != null && secret` non-blank.
  - `public void send(String jsonBody) throws NsNotifyException` — signs, posts, applies the accepted rule.
  - `public static String json(String value)` — JSON string escaping, returns the value with quotes escaped (no surrounding quotes).
  - `public static String readConfig(Config.Scope config, String key, String envName)` and `readConfigOrDefault(...)`.
  - `static String signV2(String secret, String method, String path, String timestamp, String nonce, byte[] body) throws NsNotifyException`
  - `static String signingPath(URI uri)`, `static String newNonce()`, `static URI parseUrl(String raw)`, `static long parseTimeout(String raw)`.
  - `NsNotifyException extends Exception` with `public int status()` (`-1` for I/O and configuration errors).

- [ ] **Step 1: Write the failing tests.** `RequestBodies.of(HttpRequest)` reads the publisher's bytes:

```java
package hr.delmisoft.keycloak.otp.ns;

import java.io.ByteArrayOutputStream;
import java.net.http.HttpRequest;
import java.nio.ByteBuffer;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;

final class RequestBodies {
    private RequestBodies() {}

    static byte[] of(HttpRequest request) throws Exception {
        HttpRequest.BodyPublisher publisher = request.bodyPublisher().orElseThrow();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        CompletableFuture<Void> done = new CompletableFuture<>();
        publisher.subscribe(new Flow.Subscriber<ByteBuffer>() {
            @Override public void onSubscribe(Flow.Subscription s) { s.request(Long.MAX_VALUE); }
            @Override public void onNext(ByteBuffer item) {
                byte[] chunk = new byte[item.remaining()];
                item.get(chunk);
                out.writeBytes(chunk);
            }
            @Override public void onError(Throwable t) { done.completeExceptionally(t); }
            @Override public void onComplete() { done.complete(null); }
        });
        done.get();
        return out.toByteArray();
    }
}
```

  `NsNotifyClientTest` (JUnit 5 + Mockito + Hamcrest, mocking `HttpClient` the way `HttpSmsProviderFactoryTest` does):

```java
package hr.delmisoft.keycloak.otp.ns;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class NsNotifyClientTest {

    private static final String URL = "http://ns.signals.svc.cluster.local:3000/v1/notify";
    private static final String SECRET = "ns_keycloak_secret";
    private static final String BODY =
            "{\"template_key\":\"login_otp\",\"channel\":\"sms\",\"to\":{\"phone\":\"+919876543210\"},"
            + "\"variables\":{\"message\":\"123456\"},\"priority\":\"urgent\"}";

    @SuppressWarnings("unchecked")
    private static HttpClient clientReturning(int status, String body) throws Exception {
        HttpClient client = mock(HttpClient.class);
        HttpResponse<String> response = mock(HttpResponse.class);
        doReturn(status).when(response).statusCode();
        doReturn(body).when(response).body();
        doReturn(response).when(client).send(any(), any());
        return client;
    }

    private static NsNotifyClient client(HttpClient http, String url) {
        return new NsNotifyClient(http, URI.create(url), "keycloak", SECRET, 5000L);
    }

    private static HttpRequest captured(HttpClient http) throws Exception {
        ArgumentCaptor<HttpRequest> req = ArgumentCaptor.forClass(HttpRequest.class);
        verify(http).send(req.capture(), any());
        return req.getValue();
    }

    /** Vector produced by notification-service src/lib/auth/hmac.ts (see Step 2). */
    @Test
    void signV2_matchesNotificationServiceVector() throws Exception {
        String sig = NsNotifyClient.signV2("test-secret", "POST", "/v1/notify", "1700000000",
                "00112233445566778899aabbccddeeff", BODY.getBytes(StandardCharsets.UTF_8));
        assertThat(sig, equalTo("b13a4b0821f7eba44554c6589d41466186bccf68802cb03a13799d970fde9545"));
    }

    @Test
    void send_postsBodyWithV2Headers() throws Exception {
        HttpClient http = clientReturning(202, "{\"status\":\"accepted\"}");
        client(http, URL).send(BODY);

        HttpRequest req = captured(http);
        assertThat(req.method(), equalTo("POST"));
        assertThat(req.uri().toString(), equalTo(URL));
        assertThat(req.headers().firstValue("Content-Type").orElse(""), equalTo("application/json"));
        assertThat(req.headers().firstValue("X-NS-Key").orElse(""), equalTo("keycloak"));
        assertThat(req.headers().firstValue("X-NS-Nonce").orElse(""), matchesPattern("[0-9a-f]{32}"));
        assertThat(req.headers().firstValue("X-NS-Timestamp").orElse(""), matchesPattern("\\d{10}"));
        assertThat(req.headers().firstValue("X-NS-Signature").orElse(""), matchesPattern("v2=[0-9a-f]{64}"));
        assertThat(new String(RequestBodies.of(req), StandardCharsets.UTF_8), equalTo(BODY));
    }

    @Test
    void send_signatureVerifiesAgainstCapturedBodyBytes() throws Exception {
        String body = "{\"variables\":{\"message\":\"123456\",\"note\":\"Zoë \\\"quoted\\\" \\u0001\"}}";
        HttpClient http = clientReturning(202, "");
        client(http, URL).send(body);

        HttpRequest req = captured(http);
        String expected = "v2=" + NsNotifyClient.signV2(SECRET, "POST", "/v1/notify",
                req.headers().firstValue("X-NS-Timestamp").orElseThrow(),
                req.headers().firstValue("X-NS-Nonce").orElseThrow(),
                RequestBodies.of(req));
        assertThat(req.headers().firstValue("X-NS-Signature").orElseThrow(), equalTo(expected));
    }

    @Test
    void signingPath_includesQuery() {
        assertThat(NsNotifyClient.signingPath(URI.create("http://ns:3000/v1/notify?x=1")), equalTo("/v1/notify?x=1"));
        assertThat(NsNotifyClient.signingPath(URI.create("http://ns:3000/v1/notify")), equalTo("/v1/notify"));
        assertThat(NsNotifyClient.signingPath(URI.create("http://ns:3000")), equalTo("/"));
    }

    @Test
    void send_accepts2xx() throws Exception {
        client(clientReturning(200, "{}"), URL).send(BODY);
        client(clientReturning(202, "{}"), URL).send(BODY);
    }

    @Test
    void send_409DuplicateFallbackIsAccepted() throws Exception {
        client(clientReturning(409, "{\"error\":\"duplicate-fallback\"}"), URL).send(BODY);
        client(clientReturning(409, "{\"enqueued\":false,\"reason\":\"duplicate-fallback\"}"), URL).send(BODY);
    }

    @Test
    void send_other409Fails() throws Exception {
        NsNotifyException a = assertThrows(NsNotifyException.class,
                () -> client(clientReturning(409, "{\"error\":\"idempotency_in_progress\"}"), URL).send(BODY));
        assertThat(a.status(), equalTo(409));
        assertThrows(NsNotifyException.class,
                () -> client(clientReturning(409, "not json"), URL).send(BODY));
    }

    @Test
    void send_non2xxFailsWithStatus() throws Exception {
        NsNotifyException e = assertThrows(NsNotifyException.class,
                () -> client(clientReturning(422, "{\"error\":\"unknown_template\"}"), URL).send(BODY));
        assertThat(e.status(), equalTo(422));
        assertThat(e.getMessage(), containsString("422"));
        assertThat(e.getMessage(), not(containsString("123456")));
    }

    @Test
    void send_ioErrorFails() throws Exception {
        HttpClient http = mock(HttpClient.class);
        doThrow(new java.io.IOException("connection refused")).when(http).send(any(), any());
        NsNotifyException e = assertThrows(NsNotifyException.class, () -> client(http, URL).send(BODY));
        assertThat(e.status(), equalTo(-1));
    }

    @Test
    void send_unconfiguredFailsWithoutRequest() throws Exception {
        HttpClient http = mock(HttpClient.class);
        NsNotifyClient unconfigured = new NsNotifyClient(http, null, "keycloak", SECRET, 5000L);
        assertThat(unconfigured.isConfigured(), is(false));
        NsNotifyException e = assertThrows(NsNotifyException.class, () -> unconfigured.send(BODY));
        assertThat(e.getMessage(), containsString("SMS_HTTP_URL"));
        verifyNoInteractions(http);
    }

    @Test
    void parseUrl_andParseTimeout() {
        assertThat(NsNotifyClient.parseUrl("http://ns:3000/v1/notify"), notNullValue());
        assertThat(NsNotifyClient.parseUrl("ns:3000/v1/notify"), nullValue());
        assertThat(NsNotifyClient.parseUrl("/v1/notify"), nullValue());
        assertThat(NsNotifyClient.parseUrl(" "), nullValue());
        assertThat(NsNotifyClient.parseTimeout(null), equalTo(5000L));
        assertThat(NsNotifyClient.parseTimeout("0"), equalTo(5000L));
        assertThat(NsNotifyClient.parseTimeout("abc"), equalTo(5000L));
        assertThat(NsNotifyClient.parseTimeout("2500"), equalTo(2500L));
    }

    @Test
    void json_escapes() {
        assertThat(NsNotifyClient.json("a\"b\\c\n\t\u0001"), equalTo("a\\\"b\\\\c\\n\\t\\u0001"));
    }
}
```

- [ ] **Step 2: Confirm the vector against NS.** The expected hex in `signV2_matchesNotificationServiceVector` was produced by NS's own canonical function. Re-run it to confirm (build NS first if `dist/` is missing):

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/notification-service
[ -f dist/lib/auth/hmac.js ] || pnpm build
node -e "const h=require('./dist/lib/auth/hmac.js');const body=Buffer.from('{\"template_key\":\"login_otp\",\"channel\":\"sms\",\"to\":{\"phone\":\"+919876543210\"},\"variables\":{\"message\":\"123456\"},\"priority\":\"urgent\"}','utf8');console.log(h.signHmac('v2','test-secret',h.canonicalString('v2','POST','/v1/notify','1700000000','00112233445566778899aabbccddeeff',body)))"
```

  Expected: `v2=b13a4b0821f7eba44554c6589d41466186bccf68802cb03a13799d970fde9545`. The test asserts the hex after `v2=`.

- [ ] **Step 3: Run and confirm the tests fail.** `mvn -q -pl common test -Dtest=NsNotifyClientTest` → compilation errors (class missing).

- [ ] **Step 4: Implement.**

```java
package hr.delmisoft.keycloak.otp.ns;

public class NsNotifyException extends Exception {
    private final int status;

    public NsNotifyException(String message, int status) {
        super(message);
        this.status = status;
    }

    public NsNotifyException(String message, Throwable cause) {
        super(message, cause);
        this.status = -1;
    }

    /** HTTP status NS answered with; -1 for I/O and configuration errors. */
    public int status() {
        return status;
    }
}
```

```java
package hr.delmisoft.keycloak.otp.ns;

import hr.delmisoft.keycloak.otp.sms.SmsLogSafe;
import org.jboss.logging.Logger;
import org.keycloak.Config;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * Client for notification-service {@code POST /v1/notify}, signed with HMAC v2:
 * {@code HMAC-SHA256(secret, METHOD\npath\ntimestamp\nnonce\nsha256hex(body))}.
 * The digest is taken over the exact bytes sent, so the body is serialised once.
 *
 * <p>Settings, SPI config first, then env: {@code url}/{@code SMS_HTTP_URL} (the full
 * /v1/notify URL), {@code secret}/{@code SMS_HTTP_SECRET}, {@code key-id}/{@code SMS_HTTP_KEY_ID}
 * (default {@code keycloak}), {@code timeout-ms}/{@code SMS_HTTP_TIMEOUT_MS} (default 5000).
 * One configuration serves both the SMS and the email {@code http} providers.
 *
 * <p>Accepted: any 2xx, or 409 {@code duplicate-fallback} (NS already holds this exact
 * payload, so this code is on its way). Everything else is an {@link NsNotifyException}.
 * Redirects are not followed.
 */
public final class NsNotifyClient {

    private static final Logger LOG = Logger.getLogger(NsNotifyClient.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String DEFAULT_KEY_ID = "keycloak";
    private static final long DEFAULT_TIMEOUT_MS = 5000L;
    private static final Pattern DUPLICATE_FALLBACK =
            Pattern.compile("\"(?:error|reason)\"\\s*:\\s*\"duplicate-fallback\"");

    private final HttpClient http;
    private final URI uri;
    private final String keyId;
    private final String secret;
    private final long timeoutMs;

    NsNotifyClient(HttpClient http, URI uri, String keyId, String secret, long timeoutMs) {
        this.http = http;
        this.uri = uri;
        this.keyId = keyId;
        this.secret = secret;
        this.timeoutMs = timeoutMs;
    }

    public static NsNotifyClient fromConfig(Config.Scope config) {
        String url = readConfig(config, "url", "SMS_HTTP_URL");
        String secret = readConfig(config, "secret", "SMS_HTTP_SECRET");
        String keyId = readConfigOrDefault(config, "key-id", "SMS_HTTP_KEY_ID", DEFAULT_KEY_ID);
        long timeoutMs = parseTimeout(readConfig(config, "timeout-ms", "SMS_HTTP_TIMEOUT_MS"));
        if (url == null || url.isBlank() || secret == null || secret.isBlank()) {
            LOG.warn("notification-service client not fully configured. Set SMS_HTTP_URL and SMS_HTTP_SECRET "
                    + "(or the equivalent SPI config) before activating an 'http' provider.");
        }
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(timeoutMs)).build();
        return new NsNotifyClient(http, parseUrl(url), keyId, secret, timeoutMs);
    }

    public boolean isConfigured() {
        return uri != null && secret != null && !secret.isBlank();
    }

    public void send(String jsonBody) throws NsNotifyException {
        if (!isConfigured()) {
            throw new NsNotifyException("notification-service client not configured: check SMS_HTTP_URL and SMS_HTTP_SECRET", -1);
        }
        byte[] body = jsonBody.getBytes(StandardCharsets.UTF_8);
        String timestamp = Long.toString(System.currentTimeMillis() / 1000L);
        String nonce = newNonce();
        String signature = signV2(secret, "POST", signingPath(uri), timestamp, nonce, body);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(Duration.ofMillis(timeoutMs))
                .header("Content-Type", "application/json")
                .header("X-NS-Key", keyId)
                .header("X-NS-Timestamp", timestamp)
                .header("X-NS-Nonce", nonce)
                .header("X-NS-Signature", "v2=" + signature)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();

        long startedAt = System.currentTimeMillis();
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException e) {
            throw new NsNotifyException("notification-service I/O error: " + e.getClass().getSimpleName(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new NsNotifyException("notification-service call interrupted", e);
        }
        int status = response.statusCode();
        String responseBody = response.body() == null ? "" : response.body();
        long latencyMs = System.currentTimeMillis() - startedAt;

        if (status >= 200 && status < 300) {
            LOG.debugf("notification-service accepted the send: status=%d latency_ms=%d", status, latencyMs);
            return;
        }
        if (status == 409 && DUPLICATE_FALLBACK.matcher(responseBody).find()) {
            LOG.infof("notification-service already holds this payload, treating as sent: latency_ms=%d", latencyMs);
            return;
        }
        throw new NsNotifyException("notification-service send failed: HTTP " + status + " "
                + SmsLogSafe.boundedResponse(responseBody), status);
    }

    static String signV2(String secret, String method, String path, String timestamp, String nonce, byte[] body)
            throws NsNotifyException {
        try {
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
            String canonical = String.join("\n", method.toUpperCase(), path, timestamp, nonce, digest);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new NsNotifyException("Failed to sign notification-service request", e);
        }
    }

    /** NS signs over the request target as Fastify sees it, query string included. */
    static String signingPath(URI uri) {
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) path = "/";
        String query = uri.getRawQuery();
        return query == null || query.isEmpty() ? path : path + "?" + query;
    }

    static String newNonce() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /** Null when absent or not an absolute http(s) URL; {@link #send} then fails cleanly. */
    static URI parseUrl(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            URI parsed = URI.create(raw.trim());
            if (parsed.getScheme() == null || parsed.getHost() == null) {
                LOG.errorf("SMS_HTTP_URL '%s' is not an absolute http(s) URL", raw);
                return null;
            }
            return parsed;
        } catch (IllegalArgumentException e) {
            LOG.errorf("SMS_HTTP_URL '%s' is not a valid URL: %s", raw, e.getMessage());
            return null;
        }
    }

    static long parseTimeout(String raw) {
        if (raw == null || raw.isBlank()) return DEFAULT_TIMEOUT_MS;
        try {
            long parsed = Long.parseLong(raw.trim());
            return parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
        } catch (NumberFormatException e) {
            LOG.warnf("Invalid SMS_HTTP_TIMEOUT_MS '%s', using %d", raw, DEFAULT_TIMEOUT_MS);
            return DEFAULT_TIMEOUT_MS;
        }
    }

    public static String readConfig(Config.Scope config, String key, String envName) {
        if (config != null) {
            String fromConfig = config.get(key);
            if (fromConfig != null && !fromConfig.isBlank()) return fromConfig;
        }
        return System.getenv(envName);
    }

    public static String readConfigOrDefault(Config.Scope config, String key, String envName, String defaultValue) {
        String value = readConfig(config, key, envName);
        return value != null && !value.isBlank() ? value : defaultValue;
    }

    /** JSON string-content escaping (no surrounding quotes). */
    public static String json(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
```

- [ ] **Step 5: Run.** `mvn -q -pl common test -Dtest=NsNotifyClientTest` → PASS. Then `mvn -q clean verify -B` → PASS.
- [ ] **Step 6: Commit.** `feat(ns): notification-service /v1/notify client with HMAC v2`

---

### Task 2: SMS `http` provider on `/v1/notify` (common)

**Files:**
- Modify: `common/src/main/java/hr/delmisoft/keycloak/otp/sms/HttpSmsProviderFactory.java` (whole file)
- Modify: `common/src/test/java/hr/delmisoft/keycloak/otp/sms/HttpSmsProviderFactoryTest.java` (whole file)
- Modify: `README.md` (the `http` provider section)

**Interfaces:**
- Consumes: Task 1's `NsNotifyClient` (`fromConfig`, `send`, `json`, `isConfigured`, `readConfigOrDefault`), `NsNotifyException`; `IdentifierUtil.canonicalize(KeycloakSession, String) throws PhoneNumberInvalidException`.
- Produces: `HttpSmsProviderFactory.HttpSmsProvider(KeycloakSession session, NsNotifyClient client, String templateId, String otpVarName)` (package-private); `String buildJsonBody(String e164Phone, String otpCode)`; `static String extractOtp(String message) throws SmsException` (unchanged).

- [ ] **Step 1: Write the failing tests.** Replace the test file. Keep `getId_returnsHttp`, `create_returnsNonNull`, `send_throws_onEmptyPhoneOrMessage`, `send_throws_whenMessageHasNoCode`. Build providers over a mocked `NsNotifyClient`:

```java
    private static final String MESSAGE = "Your verification code is: 123456";

    private static HttpSmsProviderFactory.HttpSmsProvider provider(NsNotifyClient client) {
        return new HttpSmsProviderFactory.HttpSmsProvider(null, client, "login_otp", "message");
    }

    private static NsNotifyClient okClient() {
        NsNotifyClient client = mock(NsNotifyClient.class);
        when(client.isConfigured()).thenReturn(true);
        return client;
    }

    @Test
    void send_postsTemplateKeyBodyToNs() throws Exception {
        NsNotifyClient client = okClient();
        provider(client).send("+919876543210", MESSAGE);
        verify(client).send("{\"template_key\":\"login_otp\",\"channel\":\"sms\","
                + "\"to\":{\"phone\":\"+919876543210\"},\"variables\":{\"message\":\"123456\"},"
                + "\"priority\":\"urgent\"}");
    }

    @Test
    void send_canonicalisesPhoneToE164() throws Exception {
        for (String raw : List.of("9876543210", "+91 98765 43210", "+91-98765-43210", "919876543210")) {
            NsNotifyClient client = okClient();
            provider(client).send(raw, MESSAGE);
            ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
            verify(client).send(body.capture());
            assertThat(raw, body.getValue(), containsString("\"phone\":\"+919876543210\""));
        }
    }

    @Test
    void send_rejectsUnparseablePhoneWithoutRequest() throws Exception {
        NsNotifyClient client = okClient();
        SmsException e = assertThrows(SmsException.class, () -> provider(client).send("12345", MESSAGE));
        assertThat(e.getMessage(), containsString("E.164"));
        assertThat(e.getMessage(), not(containsString("12345")));
        verify(client, never()).send(anyString());
    }

    @Test
    void send_usesConfiguredTemplateAndVariableName() throws Exception {
        NsNotifyClient client = okClient();
        new HttpSmsProviderFactory.HttpSmsProvider(null, client, "kc_login", "otp").send("+919876543210", MESSAGE);
        verify(client).send(argThat((String b) -> b.contains("\"template_key\":\"kc_login\"")
                && b.contains("\"variables\":{\"otp\":\"123456\"}")));
    }

    @Test
    void send_wrapsNsFailureWithoutCode() throws Exception {
        NsNotifyClient client = okClient();
        doThrow(new NsNotifyException("notification-service send failed: HTTP 422 {}", 422)).when(client).send(anyString());
        SmsException e = assertThrows(SmsException.class, () -> provider(client).send("+919876543210", MESSAGE));
        assertThat(e.getMessage(), containsString("422"));
        assertThat(e.getMessage(), not(containsString("123456")));
    }

    @Test
    void send_unconfiguredFailsWithoutRequest() throws Exception {
        NsNotifyClient client = mock(NsNotifyClient.class);
        when(client.isConfigured()).thenReturn(false);
        SmsException e = assertThrows(SmsException.class, () -> provider(client).send("+919876543210", MESSAGE));
        assertThat(e.getMessage(), containsString("not configured"));
        verify(client, never()).send(anyString());
    }
```

  Add the matching imports (`java.util.List`, `org.mockito.ArgumentCaptor`, `hr.delmisoft.keycloak.otp.ns.*`, `static org.mockito.ArgumentMatchers.anyString/argThat`, `static org.mockito.Mockito.*`). `IdentifierUtil.canonicalize(null, …)` uses the `IN` fallback region, so `session = null` is valid in tests. Delete the old v1 tests (`signingPath`, `sign_*`, `buildJsonBody` legacy shape, 409-as-sent); their behaviour now lives in `NsNotifyClientTest`.

- [ ] **Step 2: Run and confirm the tests fail.** `mvn -q -pl common test -Dtest=HttpSmsProviderFactoryTest` → compilation errors.

- [ ] **Step 3: Implement.** Replace `HttpSmsProviderFactory`:

```java
package hr.delmisoft.keycloak.otp.sms;

import hr.delmisoft.keycloak.otp.identifier.IdentifierUtil;
import hr.delmisoft.keycloak.otp.identifier.PhoneNumberInvalidException;
import hr.delmisoft.keycloak.otp.ns.NsNotifyClient;
import hr.delmisoft.keycloak.otp.ns.NsNotifyException;
import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@link SmsProvider} that hands the login OTP to notification-service
 * {@code POST /v1/notify} as {@code template_key: login_otp}, signed with HMAC v2.
 * notification-service owns the SMS vendor, its template id and the DLT-approved text,
 * so only the code is sent. Activated with {@code KC_SPI_SMS_PROVIDER=http}.
 *
 * <p>Settings (SPI config first, then env): the notification-service client's
 * ({@link NsNotifyClient}: {@code SMS_HTTP_URL}, {@code SMS_HTTP_SECRET},
 * {@code SMS_HTTP_KEY_ID}, {@code SMS_HTTP_TIMEOUT_MS}), plus
 * {@code template-id}/{@code SMS_HTTP_TEMPLATE_ID} (default {@code login_otp}) and
 * {@code otp-var-name}/{@code SMS_HTTP_OTP_VAR_NAME} (default {@code message}).
 *
 * <p>The phone is sent in E.164, canonicalised with the realm's default region.
 */
public class HttpSmsProviderFactory implements SmsProviderFactory {

    public static final String PROVIDER_ID = "http";

    private static final Logger LOG = Logger.getLogger(HttpSmsProviderFactory.class);
    private static final Pattern OTP_PATTERN = Pattern.compile("(\\d{4,10})");
    private static final String DEFAULT_TEMPLATE_ID = "login_otp";
    private static final String DEFAULT_OTP_VAR_NAME = "message";

    private NsNotifyClient client;
    private String templateId;
    private String otpVarName;

    @Override
    public void init(Config.Scope config) {
        this.client = NsNotifyClient.fromConfig(config);
        this.templateId = NsNotifyClient.readConfigOrDefault(config, "template-id", "SMS_HTTP_TEMPLATE_ID", DEFAULT_TEMPLATE_ID);
        this.otpVarName = NsNotifyClient.readConfigOrDefault(config, "otp-var-name", "SMS_HTTP_OTP_VAR_NAME", DEFAULT_OTP_VAR_NAME);
    }

    @Override
    public SmsProvider create(KeycloakSession session) {
        return new HttpSmsProvider(session, client, templateId, otpVarName);
    }

    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return PROVIDER_ID; }

    static final class HttpSmsProvider implements SmsProvider {

        private final KeycloakSession session;
        private final NsNotifyClient client;
        private final String templateId;
        private final String otpVarName;

        HttpSmsProvider(KeycloakSession session, NsNotifyClient client, String templateId, String otpVarName) {
            this.session = session;
            this.client = client;
            this.templateId = templateId;
            this.otpVarName = otpVarName;
        }

        @Override
        public void send(String phoneNumber, String message) throws SmsException {
            if (client == null || !client.isConfigured()) {
                throw new SmsException("HTTP SMS provider not configured: check SMS_HTTP_URL and SMS_HTTP_SECRET");
            }
            if (phoneNumber == null || phoneNumber.isBlank()) throw new SmsException("Phone number is empty");
            if (message == null || message.isBlank()) throw new SmsException("Message is empty");

            String otpCode = extractOtp(message);
            String e164;
            try {
                e164 = IdentifierUtil.canonicalize(session, phoneNumber);
            } catch (PhoneNumberInvalidException e) {
                LOG.warnf("OTP SMS not sent: phone=%s cannot be expressed in E.164", SmsLogSafe.maskPhone(phoneNumber));
                throw new SmsException("Phone number cannot be expressed in E.164");
            }

            try {
                client.send(buildJsonBody(e164, otpCode));
                LOG.infof("OTP SMS handed to notification-service: phone=%s", SmsLogSafe.maskPhone(e164));
            } catch (NsNotifyException e) {
                LOG.errorf("OTP SMS not accepted by notification-service: phone=%s status=%d %s",
                        SmsLogSafe.maskPhone(e164), e.status(), e.getMessage());
                throw new SmsException(e.getMessage(), e);
            }
        }

        @Override public void close() { }

        String buildJsonBody(String e164Phone, String otpCode) {
            return "{\"template_key\":\"" + NsNotifyClient.json(templateId) + "\","
                    + "\"channel\":\"sms\","
                    + "\"to\":{\"phone\":\"" + NsNotifyClient.json(e164Phone) + "\"},"
                    + "\"variables\":{\"" + NsNotifyClient.json(otpVarName) + "\":\"" + NsNotifyClient.json(otpCode) + "\"},"
                    + "\"priority\":\"urgent\"}";
        }

        static String extractOtp(String message) throws SmsException {
            Matcher m = OTP_PATTERN.matcher(message);
            if (m.find()) return m.group(1);
            throw new SmsException("HTTP SMS provider: could not extract OTP code from message");
        }
    }
}
```

- [ ] **Step 4: README.** Update the `http` provider section: it posts `/v1/notify` with HMAC v2; `SMS_HTTP_URL` is the full `/v1/notify` URL (e.g. `http://<release>-notification-service.<ns>.svc.cluster.local:3000/v1/notify`); the phone is sent in E.164; the signature covers the body digest; notification-service must have the SMS `login_otp` template configured (msg91: `SMS_LOGIN_OTP_TEMPLATE_ID`; pinnacle: `PINNACLE_LOGIN_OTP_TEMPLATE_ID` plus `SMS_LOGIN_OTP_BODY`). Positive wording.
- [ ] **Step 5: Run.** `mvn -q -pl common test` and `mvn -q clean verify -B` → PASS.
- [ ] **Step 6: Commit.** `feat(sms): http provider sends login OTP to /v1/notify with HMAC v2`

---

### Task 3: `otp-email` SPI with the `smtp` provider; call sites switched

**Files:**
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/OtpEmailSender.java`
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/OtpEmailSenderFactory.java`
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/OtpEmailSenderSpi.java`
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/OtpEmailException.java`
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/SmtpOtpEmailSenderFactory.java`
- Create: `common/src/main/resources/META-INF/services/hr.delmisoft.keycloak.otp.email.OtpEmailSenderFactory`
- Modify: `common/src/main/resources/META-INF/services/org.keycloak.provider.Spi` (add `hr.delmisoft.keycloak.otp.email.OtpEmailSenderSpi`)
- Modify: `otp-2fa/src/main/java/hr/delmisoft/keycloak/otp/OtpChannelChoiceAuthenticator.java` (`sendEmail`)
- Modify: `otp-2fa/src/main/java/hr/delmisoft/keycloak/otp/EmailOtpAuthenticator.java` (`sendEmail`)
- Modify: `otp-login/src/main/java/hr/delmisoft/keycloak/otp/grant/EmailOtpGrantType.java` (`sendOtp`)
- Test: `common/src/test/java/hr/delmisoft/keycloak/otp/email/SmtpOtpEmailSenderFactoryTest.java`, `common/src/test/java/hr/delmisoft/keycloak/otp/email/OtpEmailSenderSpiTest.java`
- Modify tests: `otp-2fa/.../EmailOtpAuthenticatorTest.java`, `otp-2fa/.../OtpChannelChoiceAuthenticatorTest.java` (stub `OtpEmailSender` instead of `EmailTemplateProvider`)

**Interfaces:**
- Produces:
  - `public interface OtpEmailSender extends org.keycloak.provider.Provider { void send(RealmModel realm, UserModel user, String code) throws OtpEmailException; }`
  - `public interface OtpEmailSenderFactory extends ProviderFactory<OtpEmailSender> {}`
  - `OtpEmailSenderSpi` — `getName()` = `"otp-email"`, not internal.
  - `OtpEmailException extends Exception` (`(String)`, `(String, Throwable)`).
  - `SmtpOtpEmailSenderFactory` — `PROVIDER_ID = "smtp"`, `order()` = 100.

- [ ] **Step 1: Write the failing tests.**

```java
// SmtpOtpEmailSenderFactoryTest
@ExtendWith(MockitoExtension.class)
class SmtpOtpEmailSenderFactoryTest {
    @Mock KeycloakSession session;
    @Mock EmailTemplateProvider templates;
    @Mock RealmModel realm;
    @Mock UserModel user;

    @Test
    void idAndOrder() {
        SmtpOtpEmailSenderFactory f = new SmtpOtpEmailSenderFactory();
        assertThat(f.getId(), equalTo("smtp"));
        assertThat(f.order(), equalTo(100));
    }

    @Test
    void smtpIsDefaultByOrder() {
        assertThat(new SmtpOtpEmailSenderFactory().order(),
                greaterThan(new HttpOtpEmailSenderFactory().order()));
    }

    @Test
    void sendsTheThemeTemplateWithTheCode() throws Exception {
        when(session.getProvider(EmailTemplateProvider.class)).thenReturn(templates);
        when(templates.setRealm(realm)).thenReturn(templates);
        when(templates.setUser(user)).thenReturn(templates);

        new SmtpOtpEmailSenderFactory().create(session).send(realm, user, "123456");

        verify(templates).send(EmailOtpConst.EMAIL_SUBJECT_KEY, EmailOtpConst.EMAIL_TEMPLATE,
                new HashMap<>(Map.of("code", "123456")));
    }

    @Test
    void wrapsEmailException() throws Exception {
        when(session.getProvider(EmailTemplateProvider.class)).thenReturn(templates);
        when(templates.setRealm(realm)).thenReturn(templates);
        when(templates.setUser(user)).thenReturn(templates);
        doThrow(new EmailException("smtp down")).when(templates).send(anyString(), anyString(), anyMap());

        assertThrows(OtpEmailException.class,
                () -> new SmtpOtpEmailSenderFactory().create(session).send(realm, user, "123456"));
    }
}

// OtpEmailSenderSpiTest
class OtpEmailSenderSpiTest {
    @Test
    void spiShape() {
        OtpEmailSenderSpi spi = new OtpEmailSenderSpi();
        assertThat(spi.getName(), equalTo("otp-email"));
        assertThat(spi.isInternal(), is(false));
        assertThat(spi.getProviderClass(), equalTo(OtpEmailSender.class));
        assertThat(spi.getProviderFactoryClass(), equalTo(OtpEmailSenderFactory.class));
    }

    @Test
    void registeredInServiceFiles() throws Exception {
        String spis = new String(getClass().getResourceAsStream(
                "/META-INF/services/org.keycloak.provider.Spi").readAllBytes(), StandardCharsets.UTF_8);
        assertThat(spis, containsString(OtpEmailSenderSpi.class.getName()));
        String factories = new String(getClass().getResourceAsStream(
                "/META-INF/services/" + OtpEmailSenderFactory.class.getName()).readAllBytes(), StandardCharsets.UTF_8);
        assertThat(factories, containsString(SmtpOtpEmailSenderFactory.class.getName()));
        assertThat(factories, containsString(HttpOtpEmailSenderFactory.class.getName()));
    }
}
```

  `smtpIsDefaultByOrder` and `registeredInServiceFiles` reference Task 4's `HttpOtpEmailSenderFactory`. Write them in this task under `@Disabled("enabled in Task 4")` and remove the annotation in Task 4, or move both to Task 4 — keep `mvn verify` green at every commit.

  In `EmailOtpAuthenticatorTest` and `OtpChannelChoiceAuthenticatorTest`, replace `@Mock EmailTemplateProvider emailProvider` / `when(session.getProvider(EmailTemplateProvider.class))` with `@Mock OtpEmailSender emailSender` / `when(session.getProvider(OtpEmailSender.class)).thenReturn(emailSender)`. Each existing email assertion becomes `verify(emailSender).send(realm, user, <code>)`; each "email failure" test stubs `doThrow(new OtpEmailException("x")).when(emailSender).send(any(), any(), anyString())` and keeps asserting the `emailSendError` page and that the target note is not set. Add one test per authenticator: after a successful send, the target auth note equals `user.getEmail()` (unchanged behaviour).

- [ ] **Step 2: Run and confirm the tests fail.** `mvn -q test` → compilation errors.

- [ ] **Step 3: Implement.**

```java
package hr.delmisoft.keycloak.otp.email;

import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.provider.Provider;

/** Delivers a login OTP by email. Keycloak generates and verifies the code. */
public interface OtpEmailSender extends Provider {
    void send(RealmModel realm, UserModel user, String code) throws OtpEmailException;
}
```

```java
package hr.delmisoft.keycloak.otp.email;

import org.keycloak.provider.ProviderFactory;

public interface OtpEmailSenderFactory extends ProviderFactory<OtpEmailSender> {
}
```

```java
package hr.delmisoft.keycloak.otp.email;

import org.keycloak.provider.Provider;
import org.keycloak.provider.ProviderFactory;
import org.keycloak.provider.Spi;

/** SPI {@code otp-email}; choose the provider with {@code KC_SPI_OTP_EMAIL_PROVIDER} (default {@code smtp}). */
public class OtpEmailSenderSpi implements Spi {
    @Override public boolean isInternal() { return false; }
    @Override public String getName() { return "otp-email"; }
    @Override public Class<? extends Provider> getProviderClass() { return OtpEmailSender.class; }
    @Override public Class<? extends ProviderFactory> getProviderFactoryClass() { return OtpEmailSenderFactory.class; }
}
```

```java
package hr.delmisoft.keycloak.otp.email;

public class OtpEmailException extends Exception {
    public OtpEmailException(String message) { super(message); }
    public OtpEmailException(String message, Throwable cause) { super(message, cause); }
}
```

```java
package hr.delmisoft.keycloak.otp.email;

import hr.delmisoft.keycloak.otp.EmailOtpConst;
import org.keycloak.Config;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

import java.util.HashMap;
import java.util.Map;

/** Today's path: Keycloak's own SMTP and the realm's email theme ({@code email-otp-code.ftl}). The default. */
public class SmtpOtpEmailSenderFactory implements OtpEmailSenderFactory {

    public static final String PROVIDER_ID = "smtp";

    @Override
    public OtpEmailSender create(KeycloakSession session) {
        return new OtpEmailSender() {
            @Override
            public void send(RealmModel realm, UserModel user, String code) throws OtpEmailException {
                try {
                    session.getProvider(EmailTemplateProvider.class)
                            .setRealm(realm)
                            .setUser(user)
                            .send(EmailOtpConst.EMAIL_SUBJECT_KEY, EmailOtpConst.EMAIL_TEMPLATE,
                                    new HashMap<>(Map.of("code", code)));
                } catch (EmailException e) {
                    throw new OtpEmailException("Failed to send OTP email over SMTP", e);
                }
            }

            @Override public void close() { }
        };
    }

    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return PROVIDER_ID; }
    /** Highest order wins when KC_SPI_OTP_EMAIL_PROVIDER is unset, so SMTP stays the default. */
    @Override public int order() { return 100; }
}
```

  `META-INF/services/hr.delmisoft.keycloak.otp.email.OtpEmailSenderFactory`:

```
hr.delmisoft.keycloak.otp.email.SmtpOtpEmailSenderFactory
```

  Call sites — `OtpChannelChoiceAuthenticator.sendEmail` (and the same change in `EmailOtpAuthenticator.sendEmail`, which keeps `EmailOtpConst.AUTH_NOTE_EMAIL` as its note key and its existing error page):

```java
    private boolean sendEmail(AuthenticationFlowContext context, String code) {
        try {
            context.getSession().getProvider(OtpEmailSender.class)
                    .send(context.getRealm(), context.getUser(), code);
            // Remember the delivery target so verification can only mark that address verified
            context.getAuthenticationSession().setAuthNote(AUTH_NOTE_TARGET, context.getUser().getEmail());
            return true;
        } catch (OtpEmailException e) {
            LOG.error("Failed to send OTP email", e);
            context.failureChallenge(AuthenticationFlowError.INTERNAL_ERROR,
                    context.form().setError("emailSendError")
                            .createErrorPage(jakarta.ws.rs.core.Response.Status.INTERNAL_SERVER_ERROR));
            return false;
        }
    }
```

  `EmailOtpGrantType.sendOtp`:

```java
    @Override
    protected String sendOtp(UserModel user, String code) throws Exception {
        session.getProvider(OtpEmailSender.class).send(realm, user, code);
        return user.getEmail();
    }
```

  Remove the now-unused `EmailTemplateProvider`, `EmailException`, `HashMap`, `Map` imports from the three call sites.

- [ ] **Step 4: Run.** `mvn -q clean verify -B` → PASS (SpotBugs included if bound to `verify`).
- [ ] **Step 5: Commit.** `feat(email): otp-email SPI; SMTP sender is the default and keeps today's behaviour`

---

### Task 4: Email `http` provider

**Files:**
- Create: `common/src/main/java/hr/delmisoft/keycloak/otp/email/HttpOtpEmailSenderFactory.java`
- Modify: `common/src/main/resources/META-INF/services/hr.delmisoft.keycloak.otp.email.OtpEmailSenderFactory` (add the http factory)
- Test: `common/src/test/java/hr/delmisoft/keycloak/otp/email/HttpOtpEmailSenderFactoryTest.java`; enable the Task 3 tests that referenced it
- Modify: `README.md` (new "Email OTP providers" section)

**Interfaces:**
- Consumes: Task 1 `NsNotifyClient`, Task 3 `OtpEmailSender`, `OtpEmailException`.
- Produces: `HttpOtpEmailSenderFactory` (`PROVIDER_ID = "http"`, `order()` = 0); `HttpOtpEmailSenderFactory.HttpOtpEmailSender(NsNotifyClient client, String templateId, String otpVarName)` (package-private); `String buildJsonBody(String email, String code)`.

- [ ] **Step 1: Write the failing tests.**

```java
@ExtendWith(MockitoExtension.class)
class HttpOtpEmailSenderFactoryTest {
    @Mock RealmModel realm;
    @Mock UserModel user;

    private static NsNotifyClient okClient() {
        NsNotifyClient client = mock(NsNotifyClient.class);
        when(client.isConfigured()).thenReturn(true);
        return client;
    }

    @Test
    void idAndOrder() {
        HttpOtpEmailSenderFactory f = new HttpOtpEmailSenderFactory();
        assertThat(f.getId(), equalTo("http"));
        assertThat(f.order(), equalTo(0));
    }

    @Test
    void send_postsTemplateKeyEmailBody() throws Exception {
        NsNotifyClient client = okClient();
        when(user.getEmail()).thenReturn("asha@example.org");
        new HttpOtpEmailSenderFactory.HttpOtpEmailSender(client, "login_otp", "message").send(realm, user, "123456");
        verify(client).send("{\"template_key\":\"login_otp\",\"channel\":\"email\","
                + "\"to\":{\"email\":\"asha@example.org\"},\"variables\":{\"message\":\"123456\"},"
                + "\"priority\":\"urgent\"}");
    }

    @Test
    void send_userWithoutEmailFailsWithoutRequest() throws Exception {
        NsNotifyClient client = okClient();
        when(user.getEmail()).thenReturn(null);
        assertThrows(OtpEmailException.class,
                () -> new HttpOtpEmailSenderFactory.HttpOtpEmailSender(client, "login_otp", "message").send(realm, user, "123456"));
        verify(client, never()).send(anyString());
    }

    @Test
    void send_unconfiguredFailsWithoutRequest() throws Exception {
        NsNotifyClient client = mock(NsNotifyClient.class);
        when(client.isConfigured()).thenReturn(false);
        OtpEmailException e = assertThrows(OtpEmailException.class,
                () -> new HttpOtpEmailSenderFactory.HttpOtpEmailSender(client, "login_otp", "message").send(realm, user, "123456"));
        assertThat(e.getMessage(), containsString("not configured"));
        verify(client, never()).send(anyString());
    }

    @Test
    void send_wrapsNsFailureWithoutCodeOrAddress() throws Exception {
        NsNotifyClient client = okClient();
        when(user.getEmail()).thenReturn("asha@example.org");
        doThrow(new NsNotifyException("notification-service send failed: HTTP 422 {}", 422)).when(client).send(anyString());
        OtpEmailException e = assertThrows(OtpEmailException.class,
                () -> new HttpOtpEmailSenderFactory.HttpOtpEmailSender(client, "login_otp", "message").send(realm, user, "123456"));
        assertThat(e.getMessage(), containsString("422"));
        assertThat(e.getMessage(), not(containsString("123456")));
        assertThat(e.getMessage(), not(containsString("asha@example.org")));
    }
}
```

- [ ] **Step 2: Run and confirm the tests fail.** `mvn -q -pl common test -Dtest=HttpOtpEmailSenderFactoryTest` → compilation errors.

- [ ] **Step 3: Implement.**

```java
package hr.delmisoft.keycloak.otp.email;

import hr.delmisoft.keycloak.otp.ns.NsNotifyClient;
import hr.delmisoft.keycloak.otp.ns.NsNotifyException;
import org.jboss.logging.Logger;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/**
 * Hands the login OTP email to notification-service {@code POST /v1/notify} as
 * {@code template_key: login_otp}, {@code channel: email}. notification-service owns the
 * copy (per-network catalogue) and the sender identity. Activated with
 * {@code KC_SPI_OTP_EMAIL_PROVIDER=http}; uses the same {@code SMS_HTTP_*} client settings
 * as the SMS {@code http} provider, plus {@code template-id} (default {@code login_otp}) and
 * {@code otp-var-name} (default {@code message}) in this SPI's scope.
 */
public class HttpOtpEmailSenderFactory implements OtpEmailSenderFactory {

    public static final String PROVIDER_ID = "http";
    private static final Logger LOG = Logger.getLogger(HttpOtpEmailSenderFactory.class);

    private NsNotifyClient client;
    private String templateId;
    private String otpVarName;

    @Override
    public void init(Config.Scope config) {
        this.client = NsNotifyClient.fromConfig(config);
        this.templateId = NsNotifyClient.readConfigOrDefault(config, "template-id", "OTP_EMAIL_HTTP_TEMPLATE_ID", "login_otp");
        this.otpVarName = NsNotifyClient.readConfigOrDefault(config, "otp-var-name", "OTP_EMAIL_HTTP_OTP_VAR_NAME", "message");
    }

    @Override
    public OtpEmailSender create(KeycloakSession session) {
        return new HttpOtpEmailSender(client, templateId, otpVarName);
    }

    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return PROVIDER_ID; }
    @Override public int order() { return 0; }

    static final class HttpOtpEmailSender implements OtpEmailSender {
        private final NsNotifyClient client;
        private final String templateId;
        private final String otpVarName;

        HttpOtpEmailSender(NsNotifyClient client, String templateId, String otpVarName) {
            this.client = client;
            this.templateId = templateId;
            this.otpVarName = otpVarName;
        }

        @Override
        public void send(RealmModel realm, UserModel user, String code) throws OtpEmailException {
            if (client == null || !client.isConfigured()) {
                throw new OtpEmailException("HTTP email OTP provider not configured: check SMS_HTTP_URL and SMS_HTTP_SECRET");
            }
            String email = user.getEmail();
            if (email == null || email.isBlank()) throw new OtpEmailException("User has no email address");
            try {
                client.send(buildJsonBody(email.trim(), code));
                LOG.info("OTP email handed to notification-service");
            } catch (NsNotifyException e) {
                LOG.errorf("OTP email not accepted by notification-service: status=%d %s", e.status(), e.getMessage());
                throw new OtpEmailException(e.getMessage(), e);
            }
        }

        @Override public void close() { }

        String buildJsonBody(String email, String code) {
            return "{\"template_key\":\"" + NsNotifyClient.json(templateId) + "\","
                    + "\"channel\":\"email\","
                    + "\"to\":{\"email\":\"" + NsNotifyClient.json(email) + "\"},"
                    + "\"variables\":{\"" + NsNotifyClient.json(otpVarName) + "\":\"" + NsNotifyClient.json(code) + "\"},"
                    + "\"priority\":\"urgent\"}";
        }
    }
}
```

  Note: `NsNotifyException` messages carry only the status and a bounded NS response; NS error bodies name the error code, never the recipient.

  Service file becomes:

```
hr.delmisoft.keycloak.otp.email.SmtpOtpEmailSenderFactory
hr.delmisoft.keycloak.otp.email.HttpOtpEmailSenderFactory
```

- [ ] **Step 4: README.** Add "Email OTP providers": SPI `otp-email`; `smtp` (default, realm SMTP + theme `email-otp-code.ftl`); `http` (notification-service `login_otp` email template; same `SMS_HTTP_URL`/`SMS_HTTP_SECRET`/`SMS_HTTP_KEY_ID`/`SMS_HTTP_TIMEOUT_MS`); select with `KC_SPI_OTP_EMAIL_PROVIDER=http`; notification-service must carry the email `login_otp` template (seeded from the network's `ns-catalogue.json`) and `EMAIL_FROM_ADDRESS`.
- [ ] **Step 5: Run.** `mvn -q clean verify -B` → PASS; `dist/target/keycloak-otp-1.2.0-SNAPSHOT.jar` contains `META-INF/services/hr.delmisoft.keycloak.otp.email.OtpEmailSenderFactory` listing both factories (`unzip -p dist/target/keycloak-otp-*.jar META-INF/services/hr.delmisoft.keycloak.otp.email.OtpEmailSenderFactory`).
- [ ] **Step 6: Commit.** `feat(email): http provider sends login OTP email to /v1/notify`

---

### Task 5: Email `login_otp` template in the catalogue generator (signals-dpg)

**Files** (signals-dpg worktree `.worktrees/ns-plan-f2/signals-dpg`, branch `feat/ns-v1-notify`):
- Create: `tools/ns-catalogue/src/login_otp_email.ts`
- Modify: `tools/ns-catalogue/src/generate.ts` (`CatalogueInput` gains `loginOtpSignoff: string`; `buildCatalogue` appends the template)
- Modify: `tools/ns-catalogue/src/schemas_repo.ts` (`generateForDir` passes the directory's sign-off)
- Test: `tools/ns-catalogue/src/__tests__/login_otp_email.test.ts`; update `generate.test.ts` template counts (39 → 40 per catalogue)

**Interfaces:**
- Produces: `export const LOGIN_OTP_SIGNOFF: Readonly<Record<string, string>>` (keyed by F2-7 directory); `export const LOGIN_OTP_SIGNOFF_DEFAULT = 'Team EkStep'`; `export function loginOtpSignoffFor(dir: string): string`; `export function loginOtpEmailTemplate(signoff: string): NsTemplateEntry`.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from 'vitest';
import { LOGIN_OTP_SIGNOFF, loginOtpEmailTemplate, loginOtpSignoffFor } from '../login_otp_email';
import { renderNsEmail } from '../render_ns';
import { emailPublishErrors } from '../ns_rules';
import { F2_7_DIRS } from '../schemas_repo';

describe('email login_otp template', () => {
  it('matches the deployed Keycloak theme copy', () => {
    const t = loginOtpEmailTemplate('Team OneTAC');
    expect(t).toEqual({
      channel: 'email',
      template_key: 'login_otp',
      subject: 'OTP to verify access',
      body_html:
        '<html><body><p>Hi!</p><p>Use the following One-Time Password (OTP) to sign in:</p>' +
        '<p><b>{{message}}</b></p><p>This OTP is valid for 5 mins. Do not share it with anyone.</p>' +
        '<p>- Team OneTAC</p></body></html>',
      body_text:
        'Hi!\n\nUse the following One-Time Password (OTP) to sign in:\n\n{{message}}\n\n' +
        'This OTP is valid for 5 mins. Do not share it with anyone.\n\n- Team OneTAC',
      variables: [{ name: 'message', type: 'string', required: true, sensitive: true }],
    });
  });

  it('escapes the sign-off in HTML only', () => {
    const t = loginOtpEmailTemplate('Team <A&B>');
    expect(t.body_html).toContain('<p>- Team &lt;A&amp;B&gt;</p>');
    expect(t.body_text).toContain('- Team <A&B>');
  });

  it('renders through NS rules with the code substituted', () => {
    const t = loginOtpEmailTemplate('Team EkStep');
    const out = renderNsEmail({ subject: t.subject!, body_html: t.body_html!, variables: t.variables }, { message: '123456' });
    expect(out.html).toContain('<p><b>123456</b></p>');
    expect(out.subject).toBe('OTP to verify access');
  });

  it('passes NS publish rules', () => {
    expect(emailPublishErrors(loginOtpEmailTemplate('Team EkStep'))).toEqual([]);
  });

  it('has a sign-off for every catalogue directory (F3-10)', () => {
    expect(Object.keys(LOGIN_OTP_SIGNOFF).sort()).toEqual([...F2_7_DIRS].sort());
    expect(loginOtpSignoffFor('blue_dot/upsdm')).toBe('Team Blue Dots');
    expect(loginOtpSignoffFor('orange_dot/onetac')).toBe('Team OneTAC');
    expect(loginOtpSignoffFor('blue_dot/ka-dhwd')).toBe('Team EkStep');
    expect(loginOtpSignoffFor('yellow_dot')).toBe('Team EkStep');
  });
});
```

  `renderNsEmail(t: NsEmailTemplate, input)` (`render_ns.ts`) and `emailPublishErrors(t: NsTemplateEntry)` (`ns_rules.ts`) are the NS-rule mirrors the golden test already uses. In `generate.test.ts`, assert every generated catalogue contains exactly one `{channel:'email', template_key:'login_otp'}` and that no policy names it.

- [ ] **Step 2: Run and confirm the tests fail.** `pnpm --filter ns-catalogue test` → module not found.

- [ ] **Step 3: Implement.**

```ts
// tools/ns-catalogue/src/login_otp_email.ts
/**
 * The email login_otp template (Plan F3). Keycloak sends it by template_key with
 * `{message: <code>}`, so it has no policy and declares only `message`.
 *
 * Copy is the deployed Keycloak theme (aggregator-dpg
 * infra/keycloak/themes/otp/email/messages/messages_en.properties: emailOtpSubject,
 * emailOtpBodyHtml, emailOtpBody) with {0} → {{message}} and {1} → the sign-off.
 * Sign-offs come from aggregator-dpg config/<network>[/<brand>]/keycloak.env
 * EMAIL_SIGNOFF; directories without one use the theme build default.
 */
import type { NsTemplateEntry } from './ns_rules';

export const LOGIN_OTP_SIGNOFF_DEFAULT = 'Team EkStep';

export const LOGIN_OTP_SIGNOFF: Readonly<Record<string, string>> = {
  blue_dot: 'Team EkStep',
  'blue_dot/ka-dhwd': LOGIN_OTP_SIGNOFF_DEFAULT,
  'blue_dot/up-gzb': LOGIN_OTP_SIGNOFF_DEFAULT,
  'blue_dot/upsdm': 'Team Blue Dots',
  purple_dot: 'Team ALIMCO',
  'purple_dot/alimco': 'Team ALIMCO',
  yellow_dot: LOGIN_OTP_SIGNOFF_DEFAULT,
  orange_dot: 'Team Orange Dots',
  'orange_dot/onetac': 'Team OneTAC',
};

export function loginOtpSignoffFor(dir: string): string {
  return LOGIN_OTP_SIGNOFF[dir] ?? LOGIN_OTP_SIGNOFF_DEFAULT;
}

import { escapeHtml } from './render_ns';

export function loginOtpEmailTemplate(signoff: string): NsTemplateEntry {
  const html =
    '<html><body><p>Hi!</p><p>Use the following One-Time Password (OTP) to sign in:</p>' +
    '<p><b>{{message}}</b></p><p>This OTP is valid for 5 mins. Do not share it with anyone.</p>' +
    `<p>- ${escapeHtml(signoff)}</p></body></html>`;
  const text =
    'Hi!\n\nUse the following One-Time Password (OTP) to sign in:\n\n{{message}}\n\n' +
    `This OTP is valid for 5 mins. Do not share it with anyone.\n\n- ${signoff}`;
  return {
    channel: 'email',
    template_key: 'login_otp',
    subject: 'OTP to verify access',
    body_html: html,
    body_text: text,
    variables: [{ name: 'message', type: 'string', required: true, sensitive: true }],
  };
}
```

  In `generate.ts`: add `loginOtpSignoff: string` to `CatalogueInput` (doc comment: "F3-10: the directory's Keycloak theme sign-off"), and in `buildCatalogue`, after the WhatsApp template push: `templates.push(loginOtpEmailTemplate(input.loginOtpSignoff));` (the existing sort keeps output deterministic). In `schemas_repo.ts` `generateForDir`, pass `loginOtpSignoff: loginOtpSignoffFor(dir)`. Update any other `buildCatalogue` callers in tests with `loginOtpSignoff: 'Team EkStep'`.

- [ ] **Step 4: Run.** `pnpm --filter ns-catalogue test`, `pnpm --filter ns-catalogue typecheck` → PASS. The golden test is unaffected (it covers only Signals cases).
- [ ] **Step 5: Commit.** `feat(ns-catalogue): email login_otp template from the Keycloak theme copy`

---

### Task 6: Regenerate the catalogues (bluedots-schemas)

**Files** (bluedots-schemas worktree `.worktrees/ns-plan-f2/bluedots-schemas`, branch `feat/ns-catalogues`): the nine `ns-catalogue.json` files; `README.md` (one paragraph).

- [ ] **Step 1: Generate.**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/signals-dpg
pnpm --filter ns-catalogue generate /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/bluedots-schemas
```

  Expected: nine files written, 40 templates each, policy counts unchanged (blue_dot 39, up-gzb/ka-dhwd 55, upsdm 39, purple_dot/alimco 31, yellow_dot 31, orange_dot/onetac 15). Warnings are the same set Task 3 of F2 recorded.

- [ ] **Step 2: Validate** with NS's schema:

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/notification-service
[ -f dist/lib/catalogue/schema.js ] || pnpm build
S=/Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/bluedots-schemas
node -e "const {parseCatalogue}=require('./dist/lib/catalogue/schema.js');for(const f of process.argv.slice(1)){const c=parseCatalogue(JSON.parse(require('fs').readFileSync(f,'utf8')));const t=c.templates.filter(x=>x.channel==='email'&&x.template_key==='login_otp');if(t.length!==1)throw new Error(f+': login_otp email count '+t.length);console.log('ok',f)}" $(cd $S && ls -d */ns-catalogue.json */*/ns-catalogue.json | sed "s|^|$S/|")
```

  Expected: `ok` for all nine.

- [ ] **Step 3: Check the diff is only the new template and the version stamp.**

```bash
cd /Users/aniket/Documents/github/aniketsaki/blue-dots-economy/.worktrees/ns-plan-f2/bluedots-schemas
git diff --stat
git diff -U0 | grep '^[+-]' | grep -v '^+++\|^---' | grep -v 'login_otp\|OTP to verify\|One-Time Password\|valid for 5 mins\|"message"\|"version"\|Team \|"channel": "email"\|"variables"\|"sensitive"\|"required"\|"type": "string"\|"name"\|body_html\|body_text\|subject\|^[+-] *[{}\[\],]*$' || echo "only the login_otp template and version changed"
```

- [ ] **Step 4: README.** In the catalogue section add: "Each catalogue also carries the email `login_otp` template that Keycloak's `http` email provider sends by `template_key`; its sign-off is the network's Keycloak theme sign-off."
- [ ] **Step 5: Commit.** `feat: email login_otp template in every catalogue`

---

## Done when

- keycloak-otp-authenticator: `mvn clean verify -B` passes locally and CI is green on the PR; the jar registers SPI `otp-email` with `smtp` and `http`, and `sms` with `http` on `/v1/notify`.
- The HMAC v2 vector test matches notification-service's `canonicalString` + `signHmac` output.
- With no new configuration, SMS and email OTP behave exactly as today (`msg91` / `smtp`).
- With `KC_SPI_SMS_PROVIDER=http` and `KC_SPI_OTP_EMAIL_PROVIDER=http`, both channels post `template_key: login_otp`, `priority: urgent`, E.164 phone / user email, `{message: <code>}`, to the `SMS_HTTP_URL`.
- signals-dpg `pnpm --filter ns-catalogue test` and `typecheck` pass; every catalogue has one email `login_otp` template with the F3-10 sign-off.
- bluedots-schemas: nine catalogues regenerated and validated with NS `parseCatalogue`.

## Follow-ups owned by F4

- **bluedots-automation, Keycloak image:** build the jar from the merged `main`, replace `dockerfiles/keycloak/providers/keycloak-otp-1.2.0-SNAPSHOT.jar`, update its sha256 and `providers/README.md` (it still names the `enhancements` branch as the build source).
- **bluedots-automation, Keycloak chart:** `SMS_HTTP_URL` default `…/v1/notify`; a `KC_SPI_OTP_EMAIL_PROVIDER` value (default `smtp`); update the values/README comments that describe `/notify` and the v1 base string.
- **NS deployment:** the catalogue mount (`NS_SEED_FILE`) delivers the email `login_otp` template; `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` must be set before any cluster uses `KC_SPI_OTP_EMAIL_PROVIDER=http`.
- **Plan G (deferred):** per-cluster flip of `KC_SPI_SMS_PROVIDER` and `KC_SPI_OTP_EMAIL_PROVIDER` to `http`, confirming the NS SMS `login_otp` template matches each cluster's current MSG91 flow and adding the Keycloak HMAC secret where missing (Test-dev).
- **Keycloak version alignment** was done in Task 4b (compile = runtime = 26.7.3).

## Self-review

- **Spec coverage.** §Stages item 9 asks for HMAC v2 (Task 1), `/v1/notify` with `template_key: login_otp` (Tasks 2, 4), and email OTP over `http` (Tasks 3–5). The NS-side email template the spec implies is Tasks 5–6. Item 10 (per-cluster flip) is Plan G, listed above.
- **Placeholders.** None; every code step carries code. Task 5 uses the existing `renderNsEmail`, `escapeHtml` (`render_ns.ts`), `emailPublishErrors` (`ns_rules.ts`) and `F2_7_DIRS` (`schemas_repo.ts`).
- **Type consistency.** `NsNotifyClient.send(String)`, `isConfigured()`, `json(String)`, `readConfigOrDefault(...)`, `NsNotifyException.status()` are used identically in Tasks 2 and 4. `OtpEmailSender.send(RealmModel, UserModel, String)` is the same in Tasks 3 and 4 and all three call sites. `loginOtpSignoffFor(dir)` / `loginOtpEmailTemplate(signoff)` match between Task 5's tests and implementation.
- **Review Focus.** Each of the five lines names its test in the owning task.
