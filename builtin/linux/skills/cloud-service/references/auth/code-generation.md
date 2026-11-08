# Auth · Write Auth Code

Use this reference when adding end-user authentication to a **published** WorkBuddy application.
The cloud service environment must already be active and `publicConfig` must be available.

## Availability Boundary

The SDK's auth surface is exactly this set — closed end to end across SDK, gateway, environment
configuration and tests:

- Email OTP registration/login.
- Email + password login.
- **Phone (SMS) OTP registration/login — WeChat mini programs only.**
- **WeChat mini-program login through `wx.login` + `cloud.auth.signInWithWechat(code, appid)`.**
- Forgot-password and signed-in password change.
- Session persistence, refresh, user lookup, sign-out and auth-state events.

### Which methods each platform supports

| Login method | Web app | WeChat mini program |
|---|---|---|
| Email OTP | yes | yes |
| Email + password | yes | yes |
| Phone (SMS) OTP | **no** | yes |
| WeChat login | **no** | yes |

**A web app supports email login only.** Never generate a phone/SMS or WeChat login path for a web
app: the provider is not available there, so the UI would compile and then fail at runtime. When a
web-app user asks for 手机号登录 / 短信登录 / 验证码登录到手机 / 微信登录, say plainly that web apps
support email login only, and offer email login — or a WeChat mini program if they need phone or
WeChat sign-in. Do not silently substitute email login without telling them why.

Do **not** generate anonymous login, username login, provider bind/unbind, captcha, device-code,
QR-code or admin user mutations. Those are not enabled in the provisioned environment and are not
part of the public SDK contract.

Provider bind/unbind is account linking, not WeChat mini-program login. Do not interpret that
restriction as a reason to reject 微信登录 / 微信授权登录 / 微信一键登录.

For a **web** app, auth is supported only on the application's registered HTTPS release domain.
WorkBuddy preview and localhost are not supported because they do not have the registered
Origin/callback binding. A **WeChat mini program** has no Origin at all and is not subject to this
boundary — it is authorized by its request-domain allowlist and `Referer`, which the mini-program
SDK handles itself. Either way, do not add a mock or localStorage-only fallback.

The right-panel **H5 mini-program preview** cannot obtain a real `wx.login` code. This is a preview
limitation, not a missing cloud-service capability: generate the WeChat login flow and verify it in
the authorized mini program on WeChat. Do not replace it with email/SMS login because of this limit.

Use `@tencent-ai/workbuddy-cloud-sdk`. Do not initialize `@cloudbase/js-sdk` separately and do not
call `/.cloud/auth/**` with hand-written `fetch`.

## Initialize Once

All three SDK forms are available — see **How an App Talks to It** in `SKILL.md` for how to choose.
For a WeChat mini program, use the 小程序 initialization in [SKILL.md](../../SKILL.md) and its
[request diagnostics adapter](../mini-program/diagnostics.md) instead of either form below.
The common Auth methods use the same client; the WeChat login flow also requires the `wx` runtime.

npm package (projects with a build step):

```ts
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
})
```

CDN `<script>` (plain HTML, no build step) — same options, reached through the `WorkBuddyCloud`
global:

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
</script>
```

Both options are **required** in every form — `endpoint` included. Never omit `endpoint` and
lean on the SDK's same-origin fallback, and never hard-code it; the only source is the
`publicConfig` returned by `workbuddy_cloud_service` (see **How an App Talks to It** in `SKILL.md`).
A mini program has no `location.origin`, so there is no same-origin fallback to lean on there at all.
The email, phone and session snippets below are form-agnostic once `cloud` exists.

The same `cloud` instance is shared by Auth, Database, Storage and LLM. After login, the shared
request layer automatically sends the latest WorkBuddy session to Database and Storage requests.

## Public Capability Table

| Capability | SDK method |
|---|---|
| Email OTP login/registration | `signInWithOtp({ email })` to send, then the returned challenge's `verify({ token })` to submit |
| Phone OTP login/registration (mini program only) | `signInWithOtp({ phone })` to send, then the returned challenge's `verify({ token })` to submit |
| Low-level send/verify OTP | `sendOtp({ email })` / `sendOtp({ phone })` + `verifyOtp(...)` — the `phone` form is mini-program only |
| Email + password login | `signInWithPassword({ email, password })` |
| WeChat mini-program login | `signInWithWechat(code, appid)` after `wx.login` |
| Verified signup after OTP | `signUp({ email \| phone, password, verificationToken })` — `password` required for email, optional for phone |
| Forgot password | `resetPasswordForEmail(email)` |
| Change password while signed in | `resetPasswordForOld({ oldPassword, newPassword })` |
| Current session | `getSession()` |
| Force refresh | `refreshSession()` |
| Verified current user | `getUser()` |
| Token for the app's own backend | `getAccessToken()` |
| Sign out | `signOut()` |
| Observe changes | `onAuthStateChange(callback)` |

## Default Login UI Contract

When the user requests WeChat login for a mini program, implement the
[WeChat Mini-Program Login](#wechat-mini-program-login) flow below. The email UI default does not
require adding email/password or SMS forms to a WeChat-only login request. Do not ask the user to
choose an alternative on the false premise that WeChat login is unsupported.

When the user asks for login, signup, auth, account, user system, 登录, 注册, 账号体系,
or 用户系统 and does not specify a login method, generate a complete email auth UI with
all of the following reachable from the page:

1. Email + password login through `cloud.auth.signInWithPassword`.
2. Email OTP login through `cloud.auth.signInWithOtp` or `sendOtp` + `verifyOtp`.
3. Verified signup with email OTP **and a password**.
4. Forgot-password flow when password login is present.

For this email default, do not implement only OTP login unless the user asks for OTP-only login. A complete
login page may use tabs, segmented controls or separate forms, but password login, OTP login and
signup must all be visible or directly reachable.

**Phone OTP is mini-program only, and on-demand even there — it is deliberately NOT part of this
default.** Add it only when the app is a WeChat mini program **and** the user actually asks for it
(手机号登录 / 短信登录 / 验证码登录到手机 / phone login / SMS login), or names it as one of the
methods they want. A bare 「做个登录页」 gets the email contract above and nothing else.

Three consequences worth stating, because they are easy to get wrong in different directions:

- Do **not** add a phone tab "for completeness" — an unrequested SMS path costs real money per
  message and widens the surface the user has to test.
- Do **not** generate a phone path in a **web** app even when it is explicitly requested. Web apps
  support email login only; say so and offer email login or a mini program instead.
- Do **not** refuse or hedge when it is requested **in a mini program**. The capability is closed
  end to end there; treat 「手机号登录」 as an ordinary supported request, not an experimental one.

When phone OTP **is** requested, requirement 3 above does not carry over: SMS signup normally has no
password, so a phone-only signup path may omit it. If the user wants phone signup *and* password
login on the same account, that needs an explicit password field — do not silently create an account
with an empty password when the UI promises password login.

## Mandatory Auth Gate for User Data

Never solve data-access errors by adding anonymous login. Anonymous login is deliberately not part
of the auth surface — protected data requires a real identity by design. Do not create
localStorage-only users, mock sessions or other fallback identities to make protected data appear to
work.

Before reading or writing user-scoped Database rows or Storage files, check the current session:

```ts
const { data: session, error } = await cloud.auth.getSession()
if (error || !session) {
  showLoginView()
  return
}
```

Only explicitly public-read tables may be queried before sign-in. Storage is for signed-in users;
do not upload, list, download, copy, move or delete user paths before sign-in. For user-owned
database rows, do not send `owner_id` from client code; the table should use
`owner_id TEXT NOT NULL DEFAULT auth.uid()` and RLS policies with
`WITH CHECK (owner_id = auth.uid())`.

## WeChat Mini-Program Login

Initialize `cloud` once with the [SKILL.md](../../SKILL.md) mini-program example and
[request diagnostics adapter](../mini-program/diagnostics.md), then call this flow from the login action:

```ts
wx.login({
  async success({ code }) {
    try {
      const appid = wx.getAccountInfoSync().miniProgram.appId
      const { data: session, error } = await cloud.auth.signInWithWechat(code, appid)
      if (error) {
        showLoginError(error.message)
        return
      }
      showSignedInView(session.user)
    } catch (error) {
      console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
        stage: 'wechat-login-handler',
        message: error instanceof Error ? error.message : '微信登录失败，请重试',
      }))
      showLoginError('微信登录失败，请重试')
    }
  },
  fail(error) {
    console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
      stage: 'wx.login',
      message: error.errMsg,
    }))
    showLoginError(error.errMsg)
  },
})
```

- The request diagnostics adapter already logs SDK request failures; the `if (error)` branch
  only updates the UI. Log `wx.login` failures and unexpected handler exceptions as above, using
  only `stage` and `message`; never log the original error object, login code or session.
- Pass the **current runtime appid**. Trial and formal releases are separate mini programs; do not
  hard-code either appid or use the WorkBuddy `applicationId` (`wbapp_…`) in its place.
- The application must have an authorized mini-program binding and its WeChat login switch must
  be enabled. These are application setup requirements, not reasons to declare login unsupported
  or omit its implementation. Check binding in the mini-program application space and the switch
  through [`management.md`](./management.md).
- The SDK sends `{ code, appid }` to `POST /.cloud/auth/v1/login-wechat`. The cloud backend exchanges
  the code and returns a WorkBuddy session; the app does not implement `jscode2session`, collect an
  AppSecret or store `openid` as its own authentication credential.
- Reuse the returned session for the same Database/Storage auth gate and session lifecycle as other
  login methods. Login establishes identity; it does not promise access to a WeChat avatar or nickname.

## Choosing Between the OTP Entry Points

This applies to both email and phone OTP.

**Both `sendOtp` and `signInWithOtp` send a new code. Neither verifies a code already entered.**
Bind sending and verification to separate user actions:

- **Get code / Resend**: call one send method and keep its result in form/component state across
  events. Save the recipient, `verificationId` and `isExistingUser`, or the returned challenge.
- **Login / Register**: use that saved result with `verifyOtp` or `challenge.verify`. Never call
  `sendOtp` or `signInWithOtp` in this handler, including when retrying an incorrect code.
- If the recipient changed or no challenge is available, ask the user to get a code for the current
  recipient. Only a successful explicit resend replaces the saved challenge; successful login clears it.

Use `sendOtp` + `verifyOtp` for the explicit handlers below. With `signInWithOtp`, save
`started.data` in the send handler and call its `verify({ token: verificationCode })` later in the
submit handler. Disable sending and submission while a send request is in flight, and apply the
resend countdown only to the send action; submitting an already received code must remain available.

Unlike the returned challenge's `verify`, a direct `verifyOtp` call does not retain the recipient
or account state. Pass `verificationId`, `token`, the same `email` or `phone`, and the
`isExistingUser` returned by `sendOtp`. Do not infer `isExistingUser` from the selected UI tab.

The SDK performs the closed flow:

```text
POST /v1/verification
  → verificationId + isExistingUser
POST /v1/verification/verify
  → one-time verificationToken
POST /v1/signin or /v1/signup
  → WorkBuddy session
```

## Email OTP

Keep the challenge outside the event handlers. Wire `sendEmailCode` to **Get code / Resend**
(a form button must have `type="button"`) and `submitEmailOtp` to **Login / Register**
(prevent the form's default submission). A new email account requires a password; collect it
on the signup form before submission. Existing users can log in with the code alone.

```ts
let pendingEmailOtp: { email: string; verificationId: string; isExistingUser: boolean } | null = null

async function sendEmailCode(email: string) {
  const sent = await cloud.auth.sendOtp({ email })
  if (sent.error) {
    showLoginError(sent.error.message)
    return
  }
  pendingEmailOtp = {
    email,
    verificationId: sent.data.verificationId,
    isExistingUser: sent.data.isExistingUser,
  }
  showCodeSent()
}

async function submitEmailOtp(email: string, verificationCode: string, password?: string) {
  const pending = pendingEmailOtp
  if (!pending || pending.email !== email) {
    showLoginError('Get a code for the current email first')
    return
  }
  const completed = await cloud.auth.verifyOtp({
    email: pending.email,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: verificationCode,
    password: pending.isExistingUser ? undefined : password,
  })
  if (completed.error) {
    showLoginError(completed.error.message)
    return
  }
  pendingEmailOtp = null
  showSignedInView(completed.data.user)
}
```

Do not expose whether an email is registered in user-facing copy.

## Phone (SMS) OTP

Mini programs only — do not generate this flow in a web app (see
[Which methods each platform supports](#which-methods-each-platform-supports)).

Keep the challenge outside the event handlers. Wire `sendPhoneCode` to **Get code / Resend**
(a web form button must have `type="button"`) and `submitPhoneLogin` to **Login / Register**
(prevent the form's default submission). Pass the current input values to each handler:

```ts
let pendingOtp: { phone: string; verificationId: string; isExistingUser: boolean } | null = null

async function sendPhoneCode(phone: string) {
  const sent = await cloud.auth.sendOtp({ phone })
  if (sent.error) {
    showLoginError(sent.error.message)
    return
  }
  pendingOtp = { phone, ...sent.data }
  showCodeSent()
}

async function submitPhoneLogin(phone: string, verificationCode: string) {
  const pending = pendingOtp
  if (!pending || pending.phone !== phone) {
    showLoginError('Get a code for the current phone number first')
    return
  }
  const completed = await cloud.auth.verifyOtp({
    phone: pending.phone,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: verificationCode,
  })
  if (completed.error) {
    showLoginError(completed.error.message)
    return
  }
  pendingOtp = null
  showSignedInView(completed.data.user)
}
```

- `email` and `phone` are **mutually exclusive** in `sendOtp` / `verifyOtp`, and the value passed to
  `verifyOtp` must be the same one used to send the code.
- **Pass the phone number through as the user typed it** (with or without a country code). The SDK
  normalizes mainland numbers to `+86 <number>` and leaves other numbers unchanged; do not duplicate
  that normalization in app code.
- `emailRedirectTo` does not apply to SMS; there is no landing link in a text message.
- SMS signup usually has no password — `password` is optional **on the phone path only**.
  **Email signup requires a password** (the SDK rejects a missing one): an account created
  without one can never sign in by password, and the failure only surfaces at the next
  login, reported as a wrong password.

Do not expose whether a phone number is registered in user-facing copy.

## Email + Password

```ts
const { data: session, error } = await cloud.auth.signInWithPassword({
  email,
  password,
})
if (error) {
  showLoginError('Wrong account or password')
  return
}
```

There is no unverified email+password signup. Signup requires a `verificationToken` obtained from OTP
verification — either email or phone OTP produces a usable one.

## Verified Signup with Password

A signup form that creates an account usable by password login must verify the account first and
pass the chosen password on the signup path. Reuse [Email OTP](#email-otp): the send handler saves
`pendingEmailOtp`; the submit handler validates the current email against the saved recipient,
then passes the complete saved state and password to `verifyOtp`:

```ts
const completed = await cloud.auth.verifyOtp({
  email: pending.email,
  verificationId: pending.verificationId,
  isExistingUser: pending.isExistingUser,
  token: verificationCode,
  password: pending.isExistingUser ? undefined : password,
})

if (completed.error) {
  showSignupError(completed.error.message)
  return
}
```

If the form is explicitly a signup form and the saved `isExistingUser` is true, route the user to
login with neutral copy instead of exposing account-existence details. Do not create an account with
an empty password when the UI promises password login.

## Password Recovery

```ts
const started = await cloud.auth.resetPasswordForEmail(email)
if (started.error) {
  showLoginError(started.error.message)
  return
}

const completed = await started.data.updateUser({
  nonce: verificationCode,
  password: newPassword,
})
if (completed.error) showLoginError(completed.error.message)
```

On success the SDK signs the user in and emits `PASSWORD_RECOVERY`.

Signed-in password change:

```ts
const result = await cloud.auth.resetPasswordForOld({
  oldPassword,
  newPassword,
})
if (result.error) showLoginError(result.error.message)
```

## Session and Route Guard

```ts
const { data: session, error } = await cloud.auth.getSession()
if (error || !session) {
  navigate('/login')
  return
}
```

`getSession()` refreshes near expiry. Use `refreshSession()` only when a forced refresh is needed.
`getUser()` calls `GET /.cloud/auth/v1/user/me`, so use it when server validation matters.

```ts
const unsubscribe = cloud.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') navigate('/login')
  renderUser(session?.user ?? null)
})
```

The SDK stores only the WorkBuddy access token and an opaque `wbrt_...` refresh handle. Provider
tokens remain in Cloud Backend Service. Never log tokens or put them in a URL.

## Calling the Application's Own Backend

```ts
const token = await cloud.auth.getAccessToken()
if (!token) throw new Error('Sign in required')

await fetch('/api/orders', {
  headers: { Authorization: `Bearer ${token}` },
})
```

The application backend may validate that token through the current application's Auth data plane;
it must not copy the Cloud Backend Service signing key.

## Error Handling

Every Auth method except `getAccessToken()` returns `{ data, error }`. Branch on stable
`error.kind`, not message text. Treat `unauthenticated`/`invalid_grant` as a request to sign in again;
keep the current session on transient `network`/`backend-unavailable` errors.

## Completion Bar

For a default email login/signup request, inspect generated source before completion:

- It must include `signInWithPassword`.
- It must include `signInWithOtp` or `sendOtp` + `verifyOtp`.
- It must include `signUp` or a verified signup path that passes `password` to `verifyOtp`.
- It must include an auth gate before user-scoped Database or Storage calls.
- It must not include `signInAnonymously`, localStorage-only users or mock sessions.
- It must not initialize `@cloudbase/js-sdk` or hand-write `fetch('/.cloud/auth/**')`.
- It must not contain a phone/SMS path unless the user asked for one — and never in a web app.

For every OTP form, check the event handlers and request sequence (local SDK mocks can verify
these rules without sending real messages):

- Every direct `verifyOtp` call passes the saved `email` or `phone`, `verificationId` and
  `isExistingUser`, plus the entered `token`. Check signup and OTP-login handlers separately.
- Get code once, then submit: exactly one `POST /v1/verification`, followed by
  `POST /v1/verification/verify` with that response's `verification_id`. Submission sends no new code.
- After verification, an existing user reaches `/v1/signin`; a new user reaches `/v1/signup`
  (with a password for email). Both must establish a session before showing signed-in content.
- Submit an incorrect code and retry: reuse the saved challenge, send no new code, and establish no
  session until verification succeeds.
- Submit before sending, or change the recipient after sending: prompt to get a code for that
  recipient without making an auth request. An explicit successful resend replaces the saved ID.
- A send failure (including HTTP 429) must not call verification or claim that a new code was sent.

Verify email/phone flows on the published web domain or in the authorized mini program:

1. OTP registration and existing-user OTP login.
2. Password login and both password-reset flows.
3. Session survives reload and refresh; concurrent refresh performs one exchange.
4. Database/Storage requests automatically carry the current session.
5. `getUser()` returns the signed-in user and sign-out removes access.

When phone OTP was requested, additionally check:

- `sendOtp` / `verifyOtp` are called with `phone` (never `email`) on that path, and the same number
  reaches both calls.
- The number is passed through as entered — no `+86` prepended, stripped or reformatted in app code.
- An existing-user SMS login and a new-user SMS signup both reach a session in that runtime.
- A wrong code leaves the user signed out; it must not fall through to a signup attempt.

When WeChat login was requested, verify:

- The login action calls `wx.login`, then `signInWithWechat(code, appid)` with the returned code and
  `wx.getAccountInfoSync().miniProgram.appId`.
- In each release being delivered (trial or formal), an authorized binding and enabled login switch
  allow login to reach a WorkBuddy session; protected Database/Storage requests reuse it.
- A `wx.login` failure or SDK error leaves the login UI in its failure state, without a mock session.
- H5 preview reports its WeChat authorization limitation; it is not counted as real-login validation.

If a login method is disabled, or Email appears degraded in the WorkBuddy management page, do not
patch around it in generated application code. Use [`management.md`](./management.md) to inspect
Provider truth.
