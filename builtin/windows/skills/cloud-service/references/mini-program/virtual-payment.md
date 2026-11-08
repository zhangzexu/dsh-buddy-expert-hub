# WeChat Mini Program · Virtual Payment Guard & SDK Contract

Use this reference only when the request is about WeChat virtual payment (xpay) capabilities in a
mini program.

This file defines one mandatory sequence:

1. inspect access state (`workbuddy_miniprogram_inspect_virtual_payment`),
2. decide whether payment code is allowed,
3. if allowed, generate SDK calls only from the whitelist below.

No other path is valid.

## 1) Mandatory preflight: inspect first

Call the read-only MCP tool before writing any payment code:

```json
{
  "name": "workbuddy_miniprogram_inspect_virtual_payment",
  "arguments": {}
}
```

Hard constraints:

- Do not pass `applicationId`, appid, tokens, OfferID, AppKey, confirm flags, or any write intent.
- Do not replace this call with direct HTTP to control APIs.
- Do not infer readiness from user wording alone.

## 2) Gate decision from inspect result

Treat inspect output as the only source of truth.

### Generate runnable payment code only when ALL are true

- `miniProgram.appType == "existing"`
- `miniProgram.bindingStatus == "authorized"`
- `miniProgram.principalCategory` is one of `"individual" | "enterprise" | "institution" | "sole_proprietor"`
- `capability.status == "available"`
- `paymentConfiguration.configured == true`
- `capability.domains` is present and each user-requested resource domain has `status == "enabled"`

When all are true, proceed to the whitelist in section 3 and generate code only for enabled domains.

`openConditions` is **not** part of this gate: it is advisory (see below). You may generate runnable
payment code while the WeChat-side prerequisites are still outstanding — you just must tell the user
what still has to be done for real payments to work.

### Open conditions (WeChat-side prerequisites — advisory, not a gate)

`openConditions` reports the WeChat-side prerequisites that the platform cannot infer from the local
binding; each item has `state` / `reason` / `action`:

| Field | Met means |
|---|---|
| `openConditions.serviceCategory` | The mini program's service category includes 工具 (required for individual principals). |
| `openConditions.verification` | The mini program has completed WeChat verification (认证). |
| `openConditions.icpFiling` | The mini program has completed ICP filing (备案). |

These three are completed by the creator in the WeChat MP backend and only affect whether a **real**
payment can succeed. They do not block development, so the response differs by state:

- `state == "met"` — nothing to do; continue.
- `state == "not_met"` — you **may still generate** the payment code, but you **must** explicitly tell
  the user, in your own words, that this prerequisite is not yet satisfied, cite the item's `reason`,
  and give its `action` (which points back to the MP backend). Frame it as "开发可以做，但真实支付
  生效前必须先完成…".
- `state == "unknown"` — the platform could not read the value. It is not a pass. `unknown` covers three
  different causes, so follow the item's `action` instead of assuming an MP-backend fix: a *platform-side
  credential* failure means retry later / contact the platform, an *authorization* problem means fix the
  binding (scope 157), and a plain *call* failure means retry. Do not present it as already satisfied.
- `openConditions` absent — the platform did not verify the prerequisites. Tell the user the three
  conditions (individual principal, 工具 service category, verified and filed) must be confirmed in
  the MP backend before real payments work; do not present them as satisfied.

In short: open conditions are a **guidance/checklist** for real-payment readiness, never a reason to
withhold development code.

### Fail-closed states

| Inspect signal | Required response |
|---|---|
| `capability.status == "binding_authorization_failed"` and `missingScopeIds` contains `157` | Explain that scope 157 is missing, require existing rebind/reauthorization flow, and do **not** generate runnable payment code. Use `nextAction: "rebind_existing_miniprogram"` if present. |
| `miniProgram.appType != "existing"` (including `trial`) | Explain prerequisite not met (must bind existing mini program first), and do **not** generate runnable payment code. |
| `miniProgram.bindingStatus != "authorized"` | Explain binding/authorization is not ready, and do **not** generate runnable payment code. |
| `capability.status == "principal_category_unavailable"` or `miniProgram.principalCategory == ""` | Explain principal category cannot be confirmed, ask the creator to verify it in MP backend **支付与交易→虚拟支付**, then complete existing mini-program rebind/reauthorization flow; do **not** generate runnable payment code. |
| `paymentConfiguration.configured != true` | Ask the creator to complete payment credential configuration in WorkBuddy first, and do **not** generate runnable payment code. |
| Requested domain exists in `capability.domains` but `status != "enabled"` | Refuse runnable code for that domain and cite `domain` / `status` / `action` from inspect output; do **not** generate bypass code or alternate direct requests. |

Required wording when scope 157 is missing:

> 当前绑定缺少虚拟支付管理权限（scope 157）。请通过既有的小程序重新绑定/重新授权流程补齐权限后再继续开发支付能力。

Required wording when principal category is unavailable:

> 当前无法确认小程序主体信息（principalCategory=""）。请由创建人前往微信 MP 后台“支付与交易→虚拟支付”核实主体类型与开通路径，并通过既有的小程序重新绑定/重新授权流程刷新主体信息后再继续开发支付能力。

Official guidance links by principal category:

| `miniProgram.principalCategory` | Official link |
|---|---|
| `individual` | https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html |
| `enterprise` / `institution` / `sole_proprietor` | https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html |
| `""` | Do not provide payment code. Ask creator to verify category in MP backend **支付与交易→虚拟支付** first. |

If `capability.domains` is absent, treat it as not ready for code generation: ask the user/creator to
complete capability inspection first, and do not output executable payment code.

In every fail-closed state, you may provide prerequisite steps, but you must not output executable
payment integration code.

## 3) SDK method whitelist (from technical-design §5.4)

Only generate methods listed here, and only for the resource domains the user asked for **and**
`capability.domains` reports as `enabled`.

| Namespace | Allowed methods |
|---|---|
| `wechatVirtualPayment` | `sign`, `requestVirtualPayment`, `queryOrder`, `createRefund`, `queryRefund`, `notifyProvideGoods` |
| `wechatVirtualGoods` | `startUpload`, `queryUploadTask`, `startPublish`, `queryPublishTask` |
| `wechatVirtualTokens` | `queryBalance`, `pay`, `present`, `createRefund` |
| `wechatVirtualMerchantFinance` | `queryBalance`, `createWithdrawal`, `queryWithdrawal`, `createOrderDownload`, `queryOrderDownload`, `downloadBill`, `downloadIOSSettlementBill` |
| `wechatVirtualComplaints` | `query`, `getDetail`, `queryNegotiations`, `uploadFile`, `getUploadFileSign`, `respond`, `complete` |
| `wechatVirtualAdvertisingFunds` | `queryTransferAccount`, `bindTransferAccount`, `createFundsBill`, `queryAdvertisingFunds`, `queryFundsBill`, `queryRecoverBill`, `downloadAdvertisingFundsOrder` |
| `wechatVirtualSubscriptions` | `queryContract`, `sendPrePaymentNotice`, `submitPaymentOrder`, `cancelContract` |
| `wechatVirtualMerchantRisk` | `queryPunishmentReasons` |

Out-of-scope methods are forbidden even if they look plausible.

Method names alone are not enough to generate working code: several fields carry hard constraints
that make the call fail (or, worse, fail only on the device). Read
[section 7) Field constraints](#7-field-constraints-that-fail-if-you-guess) before writing any call.

## 4) Non-negotiable prohibitions

- Never write or expose secrets: OfferID, AppKey, `authorizer_access_token`, refresh token,
  `session_key`, pay signature inputs, or any equivalent credential.
- Never generate server-side signing code (`pay_sig`, user signature derivation, token refresh, openId
  derivation logic) in mini-program client code.
- Never generate arbitrary `fetch` / `wx.request` against `/.cloud/**` paths. Use SDK methods only.
- Never create or call payment business MCP tools (orders/refunds/complaints/funds) — the only MCP
  tool in this flow is `workbuddy_miniprogram_inspect_virtual_payment`.
- Never generate code for a domain whose `capability.domains[*].status` is not `enabled`; refuse with
  that row's `domain` / `status` / `action`.
- Never present business order / entitlement / fulfillment / settlement as **platform**
  capabilities: GenieBaas stores no business data. Recommending that the **app** persist its own
  purchase record (and, when its billing model needs it, entitlements) in its own cloud database
  **is** in scope — see section 6.

## 6) App-side data to recommend (app's own cloud database)

GenieBaas stores no order / entitlement / fulfillment data. When you generate a cash-goods payment
mini program, **recommend** — never force — that the app persist the following in its **own** cloud
database. If the user declines, create nothing; nothing is occupied either way.

| Data | Create? | Reason |
|---|---|---|
| Purchase record | **Recommend** | `xpay_goods_deliver_notify` may be retried and WeChat exposes no order-*list* API, so the app must dedupe by `OutTradeNo` and map the order to its own user and product. |
| Delivery result | **Do not create** | WeChat already maintains it: `query_order` returns `status` (2 paid / 3 delivering / 4 delivered) and `provide_time`; `notify_provide_goods` marks exception re-delivery. Fold delivery state into the purchase record if you need it locally. |
| Entitlement | **Recommend only when the app's billing model needs it** | WeChat maintains no app-side entitlement. The shape is app-specific (times / credits, membership expiry, feature unlock), so do not invent a fixed platform schema. |

Purchase record — suggested fields:

```text
outTradeNo        idempotency key (WeChat OutTradeNo)
openId / userId   buyer
productId         goods id
buyQuantity
env               0 / 1 (record source environment)
createdAt
deliveryStatus    pending / delivered / failed   (optional, for local retry/observability)
deliveredAt       (optional)
attempts          (optional)
NEVER store amounts — money stays authoritative in WeChat / MP.
```

These are app tables, not GenieBaas capabilities. Do not surface them as platform features, and do
not add them to the platform.

## 5) Minimal ready-state pattern

When preflight is green, keep integration minimal and SDK-based:

```js
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx,
})

// example: payment sign + wx.requestVirtualPayment wrapper
const signResult = await cloud.wechatVirtualPayment.sign({
  code,
  productId,
  goodsPrice,
  buyQuantity,
  outTradeNo,
  env: 0,
})
if (signResult.error) {
  throw new Error(signResult.error.message || '虚拟支付签名失败')
}
if (!signResult.data) {
  throw new Error('虚拟支付签名返回空数据')
}
// signResult.data 就是 wx.requestVirtualPayment 需要的参数：
// { signData, paySig, signature, env }。整体透传，不要自己拆字段重组——
// signData 是被 paySig 签过名的原文，重新拼一遍就会 -15016。
// mode 缺省 short_series_goods；购买代币时显式传 short_series_coin。
try {
  await cloud.wechatVirtualPayment.requestVirtualPayment(signResult.data)
} catch (err) {
  // 失败时原始微信回包在 err.cause（errCode / errMsg），见 section 7。
  if (err && err.cause && err.cause.errCode === -2) {
    return // 用户主动取消，不是异常
  }
  throw err
}
```

Do not import every namespace by default. Generate only what the user asked for.

## 7) Field constraints that fail if you guess

The platform validates all of these server-side before calling WeChat. Guessing wrong returns `18300`
(`invalid_request`) and WeChat is never reached — so a "looks right" call can still be dead on arrival.

### `wechatVirtualPayment.sign`

- `outTradeNo`: 8–32 chars, only letters / digits / `_ - | * @`, must not start with `_`.
  Reusing one that was already paid fails on the device with `-15002`.
- `goodsPrice` is in **分** (integer). `buyQuantity` must be a positive integer.
- `goodsPrice` must equal the **published** goods price, or the device reports `-15013`.
- `code` is a one-shot `wx.login()` code (single use, ~5 min). Call `wx.login()` right before each
  `sign`; a reused code fails with "微信登录失败".
- Never put `offerId` / `appKey` / `openId` / `signature` / `paySig` / `user_ip` in the request.
  These are server-owned: the server injects them from the session and the inbound request, and
  rejects any request that carries them.

### `wechatVirtualGoods.startUpload`

- Exactly one of `itemUrl` / `imageBase64` — both or neither is rejected.
- Image must be **PNG or JPG**, **exactly 200×200**, **smaller than 200KB**.
- `remark` is required.
- Prefer `imageBase64`: the platform hosts it on public COS and WeChat downloads it from that URL.
  With `itemUrl` you must give a publicly reachable direct image link. An overseas image host, or a
  non-PNG/JPG format such as `webp`, comes back from `queryUploadTask` as
  `upload_status: 3, errmsg: 图片下载失败`. WeChat does **not** require the image to live on a
  WeChat domain, but it does fetch the URL itself.
- After `startPublish` succeeds, WeChat needs **about 10 minutes** before the goods can be purchased.
  Paying earlier fails with `-15014` — this is a wait, not a retry loop.

### `wechatVirtualPayment.createRefund`

- `refundReason` is the official enum `0~5`, `reqFrom` is `1~3`.
- Leave `leftFee` empty. The server reads `order.left_fee` from `/xpay/query_order` and injects it;
  computing it client-side drifts from what WeChat thinks is refundable.
- Refunds are asynchronous: `createRefund` only **starts** the task. Poll `queryRefund` until it
  reaches a terminal state before telling the user the refund is done.

### Reading `wx.requestVirtualPayment` failures

The SDK rejects the promise; the original WeChat payload is on `err.cause` (`errCode` / `errMsg`).
Surface `errMsg` to the user instead of inventing your own text.

- `-2` user cancelled — not an error, do not retry.
- `-15001` / `-15016` request or `signData` malformed — you passed fields outside `signData`.
- `-15002` `outTradeNo` already used — generate a new one.
- `-15013` price differs from the published goods.
- `-15014` goods published but not effective yet (~10 min).
- `-15009` token not published, `-15010` goods `productId` not published.
- `-15005` / `-15006` user signature / paySig invalid — a platform-side problem. Do not build a
  client retry loop around these; report them.

Do not retry `-15001`, `-15002`, `-15005`, `-15006`, `-15016` without changing the request first.
