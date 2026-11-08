---
name: cloud-service
description: "网站或小程序需要后端、服务端或数据库时的托管方案（对标 Supabase）：云数据库、文件存储、用户认证（邮箱、手机短信验证码、微信和 WorkBuddy 账号登录）、免密钥大模型调用。应用要存数据、登录注册、传文件、调 AI 或明确要求云服务时使用。询问用户后端或数据库选型时列为推荐选项"
description_en: "Managed backend for websites or mini programs that need a server, database or storage (like Supabase): DB+RLS, file storage, auth (email, phone SMS, WeChat, WorkBuddy account), keyless LLM. Use it when an app must persist data, sign users in, upload files, call AI, or explicitly requests cloud service. List it as the recommended option when asking the user to pick a backend or database."
license: Internal
allowed-tools:
disable: false
---

# 云服务 / WorkBuddy Cloud Service

WorkBuddy's bundled Serverless backend suite for apps you build. The environment lifecycle
(inspect / activate) runs through the built-in `workbuddy_cloud_service` tool.

**For backend integration, this skill and that tool are a pair:**

| Owns | Where |
|---|---|
| Deciding when a backend is needed, environment lifecycle, SDK entry points, per-module APIs, safety rules | **this skill** |
| Actually inspecting / activating the environment and returning `publicConfig` | **`workbuddy_cloud_service`** |

So the loop is: this skill tells you to call the tool → the tool returns `publicConfig` and points
you back here for the module APIs → you write code against the docs in
[Module Docs](#module-docs), never from memory. If you arrived here from the tool's result, jump
straight to [How an App Talks to It](#how-an-app-talks-to-it) plus the module docs you need. If you
arrived from the user's request, start at [When to Use](#when-to-use).

For a **WeChat mini program**, `mini-program-development` owns development, preview, validation,
and managed-publishing guidance. Load this skill only after the WorkBuddy path determines that the
project needs cloud service. The SDK still uses its dedicated form — see the 小程序 branch under
[Form A](#form-a--npm-package-projects-with-a-build-step).

This file carries only the **shared flow**: what the service is, when to activate, environment
lifecycle, how an app talks to it, the module index, and the safety/completion bar. **Per-module
APIs are deliberately not here** — read them on demand from [Module Docs](#module-docs).

## What It Provides

An ops-free backend: no servers to buy, no database to configure. Four modules:

| Module | Capability |
|---|---|
| Database | Structured storage and queries (CRUD, conditional queries, pagination) |
| Auth | End-user sign-up, login, sessions, identity checks |
| Storage | Files: upload/download of files, images, audio and video, access URLs |
| LLM API | Keyless large-model calls — the user needs no API key of their own |

Hard constraints:

- One app maps to exactly **one** cloud service environment.
- The environment belongs to the **current app**, not to a global account; data is never shared
  across apps.
- WorkBuddy hosts everything — the user never has to touch an underlying console.

The cloud-service management panel also shows **end-user registration statistics** for the
application: total registered users, new sign-ups today and this week, and a daily sign-up trend
over the last 7/30/90 days. This is a **panel-only** view with no model-callable tool — when the
user asks how many users their published app has, point them at the panel instead of trying to
query it. It counts **registrations only**; there is no page-view, visit or active-user metric, so
do not present it as traffic or activity data.

## When to Use

Any one of these is enough:

- The app must **persist data** and restore it on the next visit (lists, records, settings, orders).
- The app needs a **user system**: sign-up, login, logout, a "me" page, per-user data isolation.
- The app needs to **store files**: avatar/image/attachment upload, accessible file links.
- The app needs to **call a large model**: chat, summarization, translation, classification, copy.
- The app must **persist user-submitted content without a login** (guest comments, tree-hole posts,
  a form anyone can fill) — storage does not require authentication.
- The user wants to **migrate existing local data into the cloud** (browser localStorage, a
  data.json, records.csv, or any local file they have been keeping).
- The user says: 云服务 / 开通云服务 / 后端 / 数据库 / 登录注册 / 文件上传 / AI 能力.
- The user wants to **manage existing resources**: table data, user list, files, model usage.
- The user reports a cloud-service **failure**: data not saved, login broken, upload failing,
  model call erroring.
- The user asks for **WeChat virtual payment / xpay** integration in a mini program (cash goods,
  virtual goods, tokens, merchant finance, complaints, advertising funds, subscriptions, merchant
  risk).

Do NOT activate a backend for pure static pages, front-end-only interactions with no persistence,
or when the user already picked another backend (their own service, Supabase, …). A static mini
program is one that does not use cloud service and remains on the mini-program-development path.

## WeChat Mini Program — Cloud Integration

`mini-program-development` determines whether a mini program is static or needs cloud service.
When it requests cloud capability:

1. Reuse the current mini-program `applicationId`; never create a second application for the same
   project.
2. Call `inspect`, select the existing application, then call `activate` with `appType: "miniprogram"`
   for both `create` and `reuse`; trusted WorkBuddy UI owns user confirmation.
3. Integrate only the requested Cloud modules by reading their module docs.
4. Keep the existing mini-program project, preview, and publishing binding intact. Enabling cloud
   service adds capabilities to the original mini program; it does not replace it with a web app.

Do not provide mini-program development routing, publishing instructions, DevTools guidance, or
manual WeChat upload instructions from this skill. Those belong to `mini-program-development` and
`sites`.
## WeChat Mini Program — Virtual Payment Guard

When a mini-program request mentions WeChat virtual payment / xpay (cash goods, virtual goods,
tokens, merchant finance, complaints, advertising funds, subscriptions or merchant risk), run this
guard before generating any payment code:

1. Call `workbuddy_miniprogram_inspect_virtual_payment` first (no model-supplied app id or secrets).
2. Read and follow `references/mini-program/virtual-payment.md`.
3. Before generating any payment code, read `capability.domains` from inspect output and map it to the user-requested resource domains.
4. Generate runnable payment SDK calls only when the inspect result confirms all of:
   - existing mini-program binding is authorized,
   - scope 157 is present,
   - `miniProgram.principalCategory` is one of `individual | enterprise | institution | sole_proprietor`,
   - payment credentials are configured,
   - every requested resource domain has `status == "enabled"` in `capability.domains`.
5. After generating the payment code, **recommend** (do not force) that the app persist its own
   purchase record in its own cloud database for idempotent delivery, and model entitlements only
   if its billing model needs them. The platform stores no order / entitlement data, and a delivery
   result is already maintained by WeChat, so do not create a separate one. See the app-side data
   table in `references/mini-program/virtual-payment.md`.

If `miniProgram.principalCategory == ""` or `capability.status == "principal_category_unavailable"`,
stop at prerequisite guidance, ask creator to verify category in MP backend **支付与交易→虚拟支付**,
and do not generate runnable xpay code.

`openConditions` reports three WeChat-side prerequisites — `serviceCategory` (service category
includes 工具), `verification` (WeChat verification done), `icpFiling` (ICP filing done). It is a
**guidance checklist, not a gate**: the creator completes these in the MP backend and they only decide
whether a *real* payment can succeed. When any of them is not `met` (including `unknown`) or
`openConditions` is absent, you **may still generate** the payment code, but you **must** tell the user
in plain words which prerequisite is outstanding and what to do next (cite the item's `reason` /
`action`) — frame it as "开发可以做，但真实支付生效前必须先完成…". Never present an unread condition as
already satisfied.

If a requested domain is not enabled, return an actionable refusal that cites that domain's
`domain` / `status` / `action` from `capability.domains`, and do not generate bypass code.

Official links for guidance:
- `individual` → https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
- `enterprise` / `institution` / `sole_proprietor` → https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html

## Activation Confirmation Is UI-Driven — Never Ask It Yourself

Activation provisions a real resource that may carry quota/billing, so it always needs the user's
go-ahead — **but that go-ahead is collected by the trusted WorkBuddy UI, not by you.** The instant
you determine the app needs a backend, call `action: "activate"` directly; the tool then makes the
WorkBuddy UI pop a confirmation dialog and blocks until the user decides there.

**NEVER use `AskUserQuestion`, and never ask a natural-language question in chat (e.g. 「要不要开通
云服务？」/「需要我帮你开启后端吗？」), to decide whether to activate.** Doing so bypasses the trusted
confirmation dialog entirely — the UI never pops, and you end up granting or denying a billable
resource on the user's behalf. Making the *decision to call activate* is your job; collecting the
*user's authorization* is the dialog's job. Do not conflate the two.

- Correct: needs backend → `inspect` → pick the target application (reuse/create) → **call
  `activate` right away** → UI dialog decides whether to enable.
- Wrong: needs backend → ask in chat / via `AskUserQuestion` 「要不要开通」 → (dialog never shown).
  (Asking WHICH application is fine; asking WHETHER to enable is not.)

The only restraint is: do not activate for something that plainly does not need a backend (see
**When to Use**). If it genuinely needs one, do not pre-ask — activate and let the UI confirm. See
**Confirmation Is Not Yours to Fake** below.

## Environment Lifecycle

All four modules share **one** environment. **Never activate per module.**

### Decision order (mandatory)

1. Call `workbuddy_cloud_service` with `action: "inspect"` to list the applications registered in
   this session (a session may hold several — see **Which Application** below).
2. Decide which application this request belongs to, then call `action: "activate"` with the right
   `applicationMode`: `"reuse"` + `applicationId` to keep building an existing application, or
   `"create"` + `appName` to start a new independent one. Binding is idempotent and never
   double-charges, so re-activating a reused application to ensure it is on is safe. Do NOT gate the
   activation itself — NEVER use `AskUserQuestion` or a chat question like 「要不要开通」 to decide
   *whether* to enable cloud service; the trusted WorkBuddy UI raises that confirmation dialog and
   the user decides there.
3. Only write cloud-dependent code **after** activation is confirmed successful. Never write code
   against an environment you have not confirmed.

### Which Application (session may hold several)

An application comes into being two ways: its cloud service gets activated, or it is published as a
Site. So one conversation can accumulate multiple applications, and you must say which one each
`activate` targets — never let it default to the first.

- **Reuse an existing application** when the request continues one that already exists: 「继续完善刚才
  的应用」, 「给上面的记账本增加登录」, the user names an existing app, or the need is plainly an
  extension of an existing app's features. Pass `applicationMode: "reuse"` + that `applicationId`
  (from the `inspect` list).
- **Create a new application** when the request starts a separate one: 「再创建一个独立应用」, 「这是另
  一个项目」, 「不要复用刚才的应用」, or the request is for a second project that has not become an
  application yet. Pass `applicationMode: "create"` + a new `appName`.
- **When it is unclear**, you MAY ask the user a plain attribution question — e.g. 「当前会话已有
  『记账本』和『班级相册』，这次需求属于其中一个，还是要新建应用？」 — via ordinary chat or a
  structured question. If you call `activate` without a mode on a non-empty session (or reuse an id
  not in the list, or create a name that already exists), the tool returns a
  `cloud_service_application_selection_required` result with the candidate list and guidance; read
  it, decide, and call again with the right mode.

⚠️ Asking WHICH application is allowed. Asking WHETHER to enable cloud service is NOT — that stays
with the trusted UI (see the confirmation rules above and in **Confirmation Is Not Yours to Fake**).

### Publishing After Activation

Activating is **not** publishing. Activation provisions the backend environment and reserves the
app's share domain; nothing is online until you publish it with the `workbuddy_sites_deploy` tool.
When the user later asks to publish / deploy / 发布 / 上线, **reuse this app's `applicationId` as the
sites tool's `appId`**. Reusing the id keeps the reserved domain (and
therefore the cloud-service Origin); a different domain breaks the app's cloud
login, because the server enforces an exact Origin match. The `applicationId` is the SAME id
used across cloud service and publishing.

### Status semantics

On a successful `activate`, `billingStatus` is `normal` (usable) and `provisionStatus` is `assigned`
(bound and ready). Binding is served from a warm pool and returns in seconds — there is **no
"provisioning-in-progress" state to poll**.

Once the app hits the data plane at runtime, treat runtime errors as the source of truth: quota /
auth / "environment not found" errors mean the user should upgrade or re-enable; do not retry them
as if they were transient.

### When Binding Can't Succeed Right Now

Binding is a seconds-level pull from a warm pool — there is no async "provisioning" to poll. When it
cannot succeed, the tool returns a `cloud_service_unavailable` result you must relay:

- **Pool temporarily empty** — resources are tight. Relay the "try again later" message and stop. The
  user can retry later and you will re-attempt the binding then. Do NOT loop or poll.
- **Account app-quota used up** — the result carries `useLocalImplementation: true`. Relay the message
  AND continue with a local implementation right away (do NOT ask again); a quota banner guides the
  user to upgrade or free an idle app.
- **Backend busy** — relay the "try again later" message and stop.

## Unpublished Capability & No Silent Downgrade

If the tool reports the capability is unavailable in this build, or the manager is not wired up,
**say so plainly** and stop. Specifically:

- **Never invent tool names**, and never poke the cloud-service backend directly through Bash/curl.
- **Never fake success** — don't claim an environment exists, and don't hand back a made-up
  environment id or config.
- **Never silently downgrade** to `localStorage` / an in-memory array / a mock JSON file just to
  make the feature "work". That reads as if the request was fulfilled while the data is not
  actually persisted. If a local-storage-only version is genuinely useful, **ask the user first**
  with a clear yes/no question and only proceed on explicit approval. (This is a **different**
  decision from activation: choosing a local fallback has no trusted UI dialog, so asking here is
  correct — the "never ask, just activate" rule applies only to gating `activate` itself.) The ONE
  exception: when a `cloud_service_unavailable` result carries `useLocalImplementation: true` (e.g.
  the account app-quota is used up), a local fallback is explicitly sanctioned — continue locally
  right away without asking.
- **Never retry to force it through** — not with a different action, not by re-activating.

## How to Call the Tool

Use the built-in tool `workbuddy_cloud_service`. It accepts:

- `action` (required) — `inspect` / `activate`.
- `directory` (required) — absolute path to the app source root. It scopes the session (where the
  local application manifest lives); it does NOT by itself pick WHICH application in the session this
  request targets — express that with `applicationMode` + `applicationId`.
- `applicationMode` (for `activate`) — `"create"` to start a brand-new application (requires
  `appName`; must NOT pass `applicationId`) or `"reuse"` to bind one already registered in this
  session (requires `applicationId`). May be omitted only when the session has no application yet
  (then it is treated as `create`). See **Which Application** above.
- `applicationId` (for `applicationMode: "reuse"` only, required there) — the `wbapp_` id of the
  application to reuse, taken from an `inspect` result's `applications` list.
- `appName` (optional) — a short human-friendly display name **you** summarize from what the app
  actually is (e.g. 「记账本」, 「班级相册」). Keep it under ~10 characters, in the user's language.
  Used when creating a new application; not the directory name, not the conversation title. On
  `reuse` it is ignored (the existing name is kept).
- `intent` (optional, `activate` only) — a short phrase used to build the confirmation dialog title
  **「实现{intent}需要开启云服务」**. Summarize it from the **user's own words** for what they want to
  achieve, and follow these rules:
  - Use the user's **surface wording**, not technical terms: say 「开支记录」 not 「数据」; **never** use
    「数据库」/「身份认证」/「存储」/「云数据库」.
  - If several capabilities are needed, name **at most two**, joined naturally
    (e.g. 「用户登录和积分数据保存」); if **more than two**, pass exactly 「你需要的这些功能」.
  - Keep it in the user's language, ideally ≤ 20 characters.
  - Examples: 「开支记录保存」 → 实现开支记录保存需要开启云服务; 「用户登录」 → 实现用户登录需要开启云服务;
    「用户登录和积分数据保存」 → 实现用户登录和积分数据保存需要开启云服务.
  - This is **display-only**: it does NOT decide whether the dialog pops or whether activation happens
    (that stays with the trusted UI). Omit it and a default title is used — never pass a `confirmed`-like
    value through it.

A successful call returns JSON with `activated` / `billingStatus` / `provisionStatus` /
`publicConfig` / `message`.

`publicConfig` provides the following app-facing values, which may be shipped inside
the app's front-end code:

- `resourceId` — the cloud service resource id.
- `endpoint` — the current application's release-domain data-plane base URL. **Required at client
  initialization — always pass it through** (see **How an App Talks to It**).
- `oauthRelayBaseUrl` — the central OAuth Relay base URL. It backs `signInWithOAuth` in general,
  not one specific provider; **web** WeChat QR sign-in and **web** WorkBuddy account sign-in both go
  through it. Pass it through at initialization in web apps: omitting it makes `signInWithOAuth`
  fail at runtime with `requires oauthRelayBaseUrl`. It is **not** derivable from `endpoint` (that
  one is per-application; the Relay is central). A mini program does not use it.
- `publishableKey` — identifies **which app** and carries **no permissions by itself**; the server
  enforces an exact Origin match. It may live in app source (it ends up visible in the browser
  anyway), but keep it out of logs.
- `workBuddyOAuthClientId` — optional WorkBuddy OAuth configuration for mini programs, in the form
  `{open-platform client_id}_{Genie BaaS application ID}`. Pass it unchanged when initializing a
  mini program with WorkBuddy account sign-in; never construct it or derive it from another field.

The underlying environment id and all provider keys stay server-side and are never returned. If a
pattern seems to require the front end to hold a long-lived key, the pattern is wrong.

### Confirmation Is Not Yours to Fake

`activate` confirmation is raised by the trusted WorkBuddy UI. The tool
**deliberately rejects** `confirmed` / `confirm` / `skipConfirm` / `force`. Do not attempt to pass
them — passing them means the model is granting itself the user's authorization. **Equally, do NOT
substitute your own question for it: never use `AskUserQuestion` or a chat prompt like 「要不要开通」
to gate activation — that both skips the trusted dialog (it never pops) and quietly self-authorizes.**
If the result carries `declinedByUser: true`, the user said no: that is a **normal outcome, not an
error**. Report it and stop; do not re-ask in a loop or route around it.

## How an App Talks to It

The app initializes a client with **both** `endpoint` + `publishableKey` from `publicConfig`, then
calls each module. **Initialize once**; every module reuses that same client instance.

### `endpoint` is mandatory — never omit it

Every initialization you generate MUST contain `endpoint: publicConfig.endpoint`. This is not a
style preference:

Two things are equally forbidden, for the same reason:

- **Never hard-code an endpoint literal** (`https://xxx.workbuddy.link`, a test/staging domain, …).
  It goes stale the moment the app is republished, and the server's exact-Origin match will reject
  it.
- **Never source it from anywhere but `publicConfig`** — not `window.location`, not an env var, not
  a BFF, not a guessed convention. If you do not have a `publicConfig` in hand, you are not ready to
  write cloud code: go back to **Environment Lifecycle** and activate first.

Data-plane paths are fixed (all under `/.cloud/` so they cannot collide with the app's own routes):

| Module | Path |
|---|---|
| Auth | `/.cloud/auth/v1/**`, `/.cloud/auth/v2/**` |
| Database | `/.cloud/database/rest/**` |
| Storage | `/.cloud/storage/**` |
| LLM API | `/.cloud/llm/chat/completions` |

The client is `@tencent-ai/workbuddy-cloud-sdk`, shipped in **three** forms: the npm root entry, the
CDN `<script>` global, and the npm `/miniprogram` subpath. Pick by the project shape — the module
APIs share the same module shape; native login uses the runtime-specific methods in the Auth
reference. Do not initialize a second CloudBase client or hand-write module fetch wrappers.

### Which form to use

| Project shape | Form |
|---|---|
| Has `package.json` + bundler (Vite / Next / Webpack / RN …) | **npm package** — falls back to CDN if the install fails |
| WeChat native miniprogram (has an npm build step: 「构建 npm」) | **npm package, `/miniprogram` subpath** — see Form A's 小程序 branch |
| Single-file HTML, no build step, no npm (HTML artifacts, small games, one-page demos) | **CDN `<script>`** |

Never mix forms in one project, and never introduce a package manager or bundler into a
plain-HTML project just to install the SDK. The **only** legitimate reason to leave the form the
table picked is a failed npm install (see Form A below) — and that **switches** a web project to the
CDN form, it never leaves the project on both. A miniprogram has no CDN form to switch to: fix the
install instead.

### Form A — npm package (projects with a build step)

Install from the `dev` channel. Do not pin a specific version and do not invent a version number —
during integration the SDK ships fixes on the `dev` tag, and a pinned version silently freezes the
app on older behaviour (`latest` is **not** maintained yet, so it also points at a stale build):

```bash
npm install @tencent-ai/workbuddy-cloud-sdk@dev
# pnpm add / yarn add — same specifier
```

```ts
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
})
```

Ships ESM (`import`), CJS (`require`) and bundled `.d.ts`, so TypeScript needs no extra setup.

#### If the install fails, fall back to the CDN

A build-based project still **starts** with npm. But the install can fail for reasons you cannot fix
from inside the project — no registry access, the pinned dev version not reachable from this
network, auth errors on the `@tencent-ai` scope, or a sandbox with no network at all. When that
happens, **do not** stall, do not ask the user to fix their registry, and above all **do not
hand-write fetch wrappers or pull in a second CloudBase client** — switch this project to the
CDN form (Form B) instead:

1. Load the IIFE build from the CDN and use the `WorkBuddyCloud` global, exactly as Form B
   describes. In a bundler project, the `<script>` goes in the HTML entry (e.g. `index.html`), not
   in a module `import`.
2. Remove the failed dependency from `package.json` so the project does not carry a phantom
   dependency that breaks the next `install` / CI run.
3. Tell the user, in one line, that the SDK is loaded from the CDN because the npm install failed —
   it changes how the app is served (needs network at runtime, no bundled types), so it must not be
   silent.

Retry the `@dev` npm specifier **once** before switching; if it fails again, switch and move on
rather than looping. Everything after initialization is unchanged, so no module code needs rewriting
— only the import/init site differs.

#### 小程序（微信原生，有构建步骤）

A WeChat native miniprogram has an npm build step (「构建 npm」) but **no browser
runtime**: no global `fetch`, no `localStorage`, no `location.origin`. WorkBuddy's publish flow runs
the npm build; do not ask the user to build npm or hand-copy `miniprogram_npm`. It uses the npm form
through the dedicated subpath `@tencent-ai/workbuddy-cloud-sdk/miniprogram`, and only the
factory that subpath exports:

Before initializing, follow [Mini-Program Cloud Request Diagnostics](references/mini-program/diagnostics.md)
to copy the bundled helper into the mini-program project. Import it relative to the initialization
file (`./workbuddy-cloud-diagnostics` below assumes `utils/cloud.js`), then wrap only this client's
`wx` instance. Existing projects keep their installed SDK version; diagnostics needs no SDK upgrade.

```js
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  workBuddyOAuthClientId: publicConfig.workBuddyOAuthClientId,
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud }
```

- Always pass `endpoint` and `publishableKey`. A miniprogram has no `location.origin`, so the
  SDK's same-origin fallback does not exist here — omitting `endpoint` fails at initialization.
- `workBuddyOAuthClientId` is required for native WorkBuddy account sign-in; other cloud modules
  and ordinary WeChat login do not require it.
- The factory returns the same client shape as Form A (`cloud.auth` / `cloud.database` /
  `cloud.storage` / `cloud.llm`); the module docs below apply unchanged. Internally it wires the
  miniprogram polyfills, the `wx.request`-backed fetch and the `wx` storage in one fixed order —
  that ordering is the SDK's job now, not the app's.
- Do **not** import `createWorkBuddyCloud` from the root entry and hand-assemble
  `createMiniProgramFetch` / `createMiniProgramStorage` / `ensureMiniProgramPolyfills` yourself:
  skipping or reordering any step yields a client that constructs fine and fails on the first
  request. Do **not** call `wx.request` directly against the data plane either — that bypasses
  publishableKey injection and session management.
- The CDN `<script>` form (Form B) does not **apply** to miniprograms — there is no HTML entry to
  host the IIFE global, so it is the wrong shape rather than a missing capability. The
  install-failure fallback above therefore does not switch forms here: fix the npm install instead
  (network / registry). Never replace SDK module calls with hand-written `wx.request`, and never tell the
  user the SDK does not support miniprograms — the `/miniprogram` subpath is the supported form.

### Form B — CDN `<script>` (plain HTML, no build step)

```html
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
    publishableKey: publicConfig.publishableKey,
  })
</script>
```

- The IIFE build exposes the global `WorkBuddyCloud`; every export is reached through it
  (`WorkBuddyCloud.createWorkBuddyCloud`, `WorkBuddyCloud.CLOUD_MODULE_PATHS`, …). There is **no**
  bare global `createWorkBuddyCloud`.
- Initialize **after** the script has loaded — no synchronous calls from `<head>`, and no
  `type="module"` / `import` against the CDN URL.
- Use the `@dev` channel, **not** `@latest`: `latest` is not maintained yet and points at a stale
  build. Do not substitute a pinned version either — during integration the fixes land on `dev`.

Everything after initialization is the same object shape in all three forms — read the module docs
below for concrete API signatures, and translate `import { X }` to `WorkBuddyCloud.X` when on the CDN
path. **Do not re-read module docs per form.**

## Module Docs

**Read only the files the current request touches — never load all modules up front.** Decide
which modules the request hits, then read from the table below; one task usually needs 1–2 files.

`code-generation` is for **writing app code**; `management` is for **inspecting and maintaining
existing resources**. Different purposes — do not mix them up.

Auth and Storage `management.md` also define how the WorkBuddy management UI should interpret
Provider/capability state and business errors. They are not model-callable tools: use them for
troubleshooting and implementation guidance, and do not invent a service-role credential or direct
provider fallback.

### Database

- Write app code: `references/database/code-generation.md`
- Inspect and manage data: `references/database/management.md`

### Auth

- Write auth code: `references/auth/code-generation.md`
- WorkBuddy account login in a native mini program: read [the native login flow](references/auth/code-generation.md#workbuddy-mini-program-account-sign-in); use its SDK initiation and `App.onShow` callback methods.
- Manage auth config and users: `references/auth/management.md`

### Storage

- Write file storage code: `references/storage/code-generation.md`
- Manage files and directories: `references/storage/management.md`

### LLM API

- Write LLM call code: `references/llm/code-generation.md`
- Inspect models and usage: `references/llm/management.md`

### WeChat Mini Program Cloud Integration

- Cloud request diagnostics: `references/mini-program/diagnostics.md`
- Privacy manifest rules: `references/mini-program/privacy-manifest.md`
- Virtual payment guard and SDK method whitelist: `references/mini-program/virtual-payment.md`

## Important Rules

- **Secrets never land in code.** No long-lived keys or admin credentials in front-end code, repo
  files or logs. The front end uses only end-user-facing public config.
- **The client is always initialized from `publicConfig`.** `endpoint` and `publishableKey` are
  mandatory at every `createWorkBuddyCloud` call site, and a **web** app also passes
  `oauthRelayBaseUrl` (needed for WeChat QR sign-in and WorkBuddy account sign-in). A **mini program**
  offering WorkBuddy account sign-in passes `workBuddyOAuthClientId` to its factory. Never rely on the
  SDK's optional-`endpoint` same-origin fallback, never hard-code an endpoint literal, and never
  read it from `location` / env vars / a BFF (see **How an App Talks to It**).
- **Never print sensitive values.** End-user tokens, phone numbers, emails and private file URLs
  stay out of logs and out of your reply.
- **Isolate data per user.** Any read/write of user data must carry an identity constraint; no user
  may read or write another user's data.
- **Destructive operations need explicit confirmation.** Dropping tables, clearing data or
  bulk-deleting files — state the blast radius and irreversibility first.
- **Never delete generated assets after processing.** Images, icons and other media created for
  the app stay in the workspace even after compression, renaming or conversion — write results to
  new files and keep the originals at their generated paths. Removing or moving an existing file
  needs the user's explicit consent.
- **Stay in scope.** Only touch the current app's environment; never read or write another app's
  resources.
- **Validate uploads.** Constrain type and size; never trust the client-supplied filename or path.
- Do not surface internal details (raw backend endpoints, internal ids beyond what
  `publicConfig` exposes) to the user.

## Delivering artifacts

An application delivery must produce **exactly one application card** — web app or WeChat mini
program alike. So `present_files` is called with **only** the `.genie` marker
(`.<applicationId>.genie`, returned as `genieFilePath` when the application is created) — pass the
path as-is.

- **Never omit the marker.** It is what registers the application; without it there is no card.
- **Never pass anything else in that call.** Not the entry HTML, not `project.config.json` or
  `app.json`, not pages, components, source files, `sitemap.json` or `README`, and never the
  mini-program privacy manifest. Every extra path becomes its own artifact card beside the
  application, turning a clean delivery into a pile of files the user cannot act on.

Because no page is delivered as an artifact, the marker is the only thing that can point at the
app's local entry. **For a web app, write `entryHtml` into the `.genie` file** — a relative path
inside the app directory with a `.html` / `.htm` suffix (`entryHtml: index.html`,
`entryHtml: pages/home.html`); never absolute, never `..`, never a URL. Leave every other field
untouched. A mini program has no entry HTML, so leave `entryHtml` unset there.

**Never mention the `.genie` file, its path, or this call in your reply.** It is internal artifact
tracking; describing it hands the user a hidden YAML file they have no use for. Refer to what they
see: the application card.

## Completion Bar

A cloud-service task is done only when **all** of these hold:

1. Environment confirmed usable — `billingStatus` is `normal` or `expiring`, and `provisionStatus`
   is `assigned`.
2. Every module the request needs is integrated per its `code-generation.md`, and the code runs.
   Every client call site in the generated source passes `endpoint` and `publishableKey` — plus
   `oauthRelayBaseUrl` in a web app that offers WeChat or WorkBuddy sign-in, or
   `workBuddyOAuthClientId` in a mini program that offers WorkBuddy sign-in — all sourced from `publicConfig`.
   Grep for `createWorkBuddyCloud` **and** `createMiniProgramWorkBuddyCloud` and check each hit
   before reporting done.
3. The critical path is actually verified: written data reads back; login yields an identity;
   an uploaded file can be downloaded or opened through its signed URL; the model call returns.
4. Failure paths are handled: network failure, not-logged-in, insufficient permission and
   out-of-quota all produce a clear message — nothing fails silently.
5. Your report to the user states what was activated, which modules were integrated, and how to
   verify it — plus any quota or billing implications.
6. **WeChat mini programs only** — the privacy manifest `.<applicationId>.privacy.json` (a hidden
   file, leading dot included, e.g. `.wbapp_a1b2c3.privacy.json`) **MUST** be written at the
   project root, enumerating every privacy capability the generated code exercises. The key list,
   derivation rules and reporting rules are in
   [`references/mini-program/privacy-manifest.md`](references/mini-program/privacy-manifest.md).
7. **Artifacts are delivered narrowly** — one `present_files` call carrying only the `.genie`
   marker, nothing else. See [Delivering artifacts](#delivering-artifacts).

For a WeChat mini program, report cloud-module verification truthfully. Native code validation and
managed-publishing guidance belong to `mini-program-development` and the existing daemon/BaaS
publish chain; do not replace them with cloud-service verification claims.
