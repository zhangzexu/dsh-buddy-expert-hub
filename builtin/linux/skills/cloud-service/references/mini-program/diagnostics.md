# Mini-Program Cloud Request Diagnostics

Use the existing SDK's `wx` injection option to make failed cloud requests visible in the phone's
vConsole. This requires no SDK upgrade or new dependency. Apply it when creating a cloud-backed
mini program, or when repairing/debugging cloud requests in an existing one.

## Install in the generated project

1. Read and copy [`../../assets/miniprogram-diagnostics.js`](../../assets/miniprogram-diagnostics.js)
   unchanged to `utils/workbuddy-cloud-diagnostics.js` under the project's actual mini-program
   source root. Copy the asset into the project; do not import it from the installed Skill path.
2. At the existing, single `createMiniProgramWorkBuddyCloud` initialization, import the helper using
   a path relative to that file and pass `wx: createDiagnosticWx(wx)`. If the client already uses
   a custom `wx` instance, wrap that instance once. Reuse an existing helper instead of wrapping twice.
3. Keep the existing SDK version, public configuration, client instance and module calls. Do not
   change `node_modules`, `miniprogram_npm`, global `wx.request`, or the SDK's request/auth logic.

For a client initialized in `utils/cloud.js`:

```js
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx: createDiagnosticWx(wx),
})
```

On initialization, the helper logs one `[WorkBuddy Cloud] initialized` line with the runtime's
WeChat `appid` from `wx.getAccountInfoSync().miniProgram.appId`, before any login request is made.
Custom `wx` adapters without `getAccountInfoSync` skip this initialization log.

The helper logs one `[WorkBuddy Cloud] request failed` line for a failed request, with method,
URL without credentials/query/fragment, duration, HTTP status (0 when no response), error code and
message. For WeChat login it includes the request's `appid`; for HTTP errors it reads request/trace
IDs from response headers when present. It never logs request bodies, credentials or full responses.
Successes and the explicit `request:fail abort` cancellation stay silent.

It forwards callbacks and storage calls, returns the original RequestTask, and leaves streaming
listeners intact. This only diagnoses requests made by this cloud client. Native `wx.login` failures
and unexpected exceptions need the separate logging in [the login flow](../auth/code-generation.md#wechat-mini-program-login).
Do not duplicate SDK request logs in the page's handled `error` branch.

## Verify on the phone

Existing published code does not change automatically: add the helper and rebuild/publish the
mini program before scanning the new code. Enable debugging and reopen the mini program, then find
`[WorkBuddy Cloud] initialized` in vConsole's log panel and copy its `appid` without needing to log in.
Reproduce a failure to find `[WorkBuddy Cloud] request failed`.

- Domain rejection: `stage=network`, `status=0`, and `url not in domain list`; no server request ID.
  The rejected URL should be the environment's fixed gateway — read it from `publicConfig.endpoint`
  and compare against WeChat's request / upload / download allowlist
  (see [`routing.md` §C2](routing.md)). Do **not** work around it by editing `publicConfig.endpoint`
  or by hand-writing `wx.request`: a mini program cannot call any host outside that allowlist, so the
  fix is to get the fixed host registered, not to point the client elsewhere.
- Authorization rejection: `stage=http`, `status=403`, the server's message and any returned request ID.
- Successful login: no failure log, and the existing signed-in flow continues normally.

Do not claim phone validation from an H5 preview or mock test. Record which target was actually tested.
