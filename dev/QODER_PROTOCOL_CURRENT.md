# Qoder Global protocol — current state (2026-09-05)

Compiled from four reference implementations. **CN verified live on 2026-09-05**
(real PAT: exchange, userinfo, signed model list, streaming inference incl.
reasoning + tool calls + 5 concurrent turns — `tests/qoder-live.test.ts`).
Global remains unverified live (no Global account at hand); every constant is
isolated in provider config/defaults per the drift policy (ТЗ §23).

References used:

| Repo | Role | License |
|---|---|---|
| `simonsmh/pi-provider-qoder` | main structural reference (direct TS provider) | MIT (package.json) |
| `Liki4/qodercli2api` | protocol oracle (docs/inference-protocol.md, behavior only) | AGPL-3.0 — no code copied |
| `Hemilt0n/qoder-cpa` | independent Global confirmation (PAT exchange, COSY, discovery) | no LICENSE file — reference only |
| `Sliverkiss/cpa-plugin` | drift history / CN differential reference | reference only |

## Endpoints (Global)

| Purpose | URL |
|---|---|
| Gateway base | `https://api3.qoder.sh` (older qodercli2api doc pins `api2.qoder.sh`; both newer direct providers use `api3`) |
| Inference | `POST {gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` |
| Model list | `GET {gateway}/algo/api/v2/model/list?Encode=1` (COSY-signed) |
| PAT exchange | `POST https://openapi.qoder.sh/api/v1/jobToken/exchange` (no COSY signature) |
| User info | `GET https://openapi.qoder.sh/api/v1/userinfo` (`Authorization: Bearer <token>`) |
| Device login page | `https://qoder.com/device/selectAccounts?challenge=<S256>&challenge_method=S256&machine_id=<uuid>&nonce=<uuid>` |
| Device token poll | `GET https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` (202/404 = pending; 200 = `{token, refresh_token, user_id, expires_at?/expires_in?(s)}`) |
| Token refresh | `POST https://center.qoder.sh/algo/api/v3/user/refresh_token` (`Bearer <access>`, body `{refreshToken}`; here `expires_in` is **seconds**) |
| Quota usage (optional) | `GET https://openapi.qoder.sh/api/v2/quota/usage` |

## Endpoints (CN)

Same wire paths and the SAME COSY signing (identical pinned RSA key, per
cpa-plugin §3) on CN hosts:

| Purpose | URL |
|---|---|
| Gateway base | `https://gateway.qoder.com.cn` |
| Inference / model list | same `/algo/api/v2/...` paths under the CN gateway |
| PAT exchange | `POST https://openapi.qoder.com.cn/api/v1/jobToken/exchange` → `{token: jt-…(24h), refresh_token: jrt-…(48h), expires_in: ms}` |
| PAT job-token refresh | `POST https://openapi.qoder.com.cn/api/v1/jobToken/refresh` `{refresh_token}` (48h window; beyond it, re-exchange the PAT) |
| PAT creation | web session only: `qoder.com.cn/account/integrations` (no API endpoint; `openapi.qoder.com.cn` 404s it) |

**CN is PAT-only.** The cpa-plugin capability matrix shows CN device tokens
(`dt-`) cannot authenticate inference, and pi-provider-qoder marks CN
`supportsBrowserLogin: false`. CN is also stricter about identity: a
placeholder COSY uid is rejected with code 105 ("Login expired"), so the real
uid from userinfo is required (the adapter fails closed when it is missing).

**CN live catalog (verified 2026-09-05):** `auto`, `qmodel_38max` (Qwen3.8-Max,
efforts low/medium/xhigh), `qfmodel` (Qwen3.8-Flash, low/medium/xhigh),
`qmodel_latest` (Qwen3.7-Max, toggle), `qmodel` (Qwen3.7-Plus, toggle),
`q37fmodel` (Qwen3.7-Flash), `dmodel` (DeepSeek-V4-Pro, efforts **high/max**),
`dfmodel` (DeepSeek-V4-Flash, low/high/max), `gmodel` (GLM-5.3, low/high/max),
`gfmodel` (GLM-5.3-Flash, high/max), `gm51model` (GLM-5.2, high/max),
`kmodel` (Kimi-K2.7-Code, reasoning toggle, 256K ctx), `mmodel` (MiniMax-M2.7,
NO reasoning, NO vision, 200K ctx). All non-kmodel/mmodel entries advertise
200K/400K/1M context options. Note the ladders differ from the Global static
table — another reason capability must come from live discovery, not docs.

## Auth chain

Two credential shapes, both accepted by the adapter:

**A. PAT (P0, automation):**
1. PAT (`pt-...`) → `POST /api/v1/jobToken/exchange` body `{"personal_token": pat}`,
   headers `Cosy-Version: 1.0.1`, `Cosy-ClientType: 5`.
   Response: `{token: "jt-...", refresh_token: "jrt-...", expires_at? | expires_in?}`.
   `expires_in` is milliseconds (observed 86400000 = 24h).
2. Job token authenticates inference through COSY headers and the COSY payload
   `info` (AES-encrypted `{uid, security_oauth_token, name, aid, email}`).
3. Re-exchange the PAT on expiry (job token 24h; refresh token 48h — re-exchange
   is the simpler, PAT-only path both TS and Go direct providers use).
4. userinfo is best-effort identity resolution; COSY `Cosy-User` needs the real
   `uid` (Qoder CN rejects placeholder uid with code 105 "Login expired").

**B. Device browser login (P1, dashboard):** PKCE S256 + machine id + nonce →
user approves at `qoder.com/device/selectAccounts` → poll `deviceToken/poll`
until `{token, refresh_token, user_id}`. The returned token signs COSY directly
(no job-token exchange); `refresh_token` renews it at
`center.qoder.sh/algo/api/v3/user/refresh_token`. The machine id is reused from
an installed Qoder CLI (`~/.qoder/.auth/machine_id`) when present, so both
clients present as one device.

## COSY signing (pure software — no WASM)

Confirmed by three independent implementations (TS, Go, Python) against both
Global and CN; WASM is not required.

- AES-128-CBC encrypt `JSON.stringify(userInfo)` with a random 16-char key
  (key == IV), base64 → payload `info`.
- RSA public-encrypt (PKCS#1 v1.5) the AES key with the pinned Qoder public key,
  base64 → `Cosy-Key`.
- Payload JSON fixed field order:
  `{"version":"v1","requestId":<uuid>,"info":<info>,"cosyVersion":<ver>,"ideVersion":""}`,
  standard padded base64 → `payloadB64`.
- Signature: `lowerhex(MD5(payloadB64 + "\n" + cosyKey + "\n" + unixSeconds + "\n" + encodedBody + "\n" + sigPath))`.
  `sigPath` = URL pathname minus the `/algo` prefix, no query.
  For inference: `/api/v2/service/pro/sse/agent_chat_generation`.
- `Authorization: Bearer COSY.{payloadB64}.{sigHex}` plus `Cosy-*` headers
  (User, Date, Version `1.1.38` on gateway / `1.0.1` on openapi, Machineid,
  Machinetoken, Machinetype `5`, Machineos, Clienttype `5`, Bodyhash = MD5(body),
  Bodylength, Sigpath, Data-Policy `disagree`, Login-Version `v2`, X-Request-Id).
- A stale gateway `Cosy-Version` makes `/model/list` return a reduced list
  (pi-provider comment) — keep the gateway version current.

## Body codec ("qoder-waf" encoding)

Request body only (responses are plaintext SSE):

1. standard padded base64 of the raw JSON bytes;
2. map each standard-base64 char to
   `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`,
   `=` → `$`;
3. outer-third swap: `k=floor(len/3)` → `s[len-k:] + s[k:len-k] + s[:k]`.

Steps 2 and 3 commute (position-independent char map); both orders appear in the
references and produce identical bytes. Deterministic, reversible, not encryption.

## Inference request body (RemoteChatAsk)

Key fields (both direct providers agree): `request_id` (unique UUID per inference;
server returns code 103 on duplicates — never reuse across retries of a NEW
logical request; the qodercli2api proxy keeps the same `request_id` across its
own transport retries and only re-signs the COSY wrapper), `request_set_id` /
`chat_record_id` (stable per logical turn hash), `session_id` (stable per session
for prompt-cache affinity — we generate per Codex thread when available,
per-request UUID otherwise; treated as transport metadata only),
`stream: true`, `chat_task: "FREE_INPUT"`, `is_reply`, `session_type: "qodercli"`,
`agent_id: "agent_common"`, `task_id: "common"`, `version: "3"`, `source: 1`,
`system: ""` (server ignores it; system prompt goes in as a leading
`role:"system"` message instead), `messages` (OpenAI chat shape; assistant turns
with tool_calls but no text get a single-space content placeholder or the gateway
drops them), `tools` (OpenAI function shape), `parameters.max_tokens`,
`parameters.enable_thinking` (+`parameters.reasoning_effort` only for
effort-capable models; toggle-only models take `enable_thinking` alone),
`chat_context.extra.modelConfig {key,is_reasoning}`, `model_config` (echoed
catalog entry), `business {product:"cli",type:"agent",stage:"start",...}`.
Headers: `X-Model-Key`, `X-Model-Source` (`system`|`custom`).

## Response: plaintext SSE

Frames are `data:{...}` envelopes:
`{"headers":{...},"body":"<inner JSON string>","statusCodeValue":200,"statusCode":"OK"}`.

- `body` parses to an OpenAI `chat.completion.chunk`: `delta.content`,
  `delta.reasoning_content`, `delta.tool_calls` (fragmented `function.arguments`),
  `finish_reason`, `usage` (OpenAI semantics; `prompt_tokens` INCLUDES
  `cached_tokens`). Usage may arrive in the same chunk as `finish_reason` or after
  it — keep reading until a terminal.
- `[DONE]` appears both bare (`data: [DONE]`) and wrapped (`body: "[DONE]"`);
  the gateway may keep the socket open after it — treat it as terminal and cancel
  the reader (pi-provider behavior). qodercli2api additionally documents an
  authoritative `event:finish` frame with duration stats; accept either, plus EOF
  after a complete terminal chunk.
- `statusCodeValue != 200` is an error envelope (body carries the error text).
- Models sometimes route a literal `<thinking>`/`</thinking>` tag into
  `reasoning_content`/`content`; strip tag artifacts (pi-provider thinking.ts).

## Model catalog (`/model/list`)

Response `{chat: QoderModelEntry[]}`; entry: `key` (upstream wire id, e.g.
`dmodel`, `kmodel_latest`), `enable`, `display_name`, `max_input_tokens` (stale
180K floor — do not trust), `context_config` (map of named options with
`token_count`/`is_default`; 200K/400K/1M selectable on some models),
`is_vl` (vision), `is_reasoning`, `thinking_config`
(`enabled.efforts{low,medium,high,xhigh,max}` or toggle-only; `disabled`),
`source` (`system`|`custom`).

**Naming policy (operator-facing):** models are addressed by their VENDOR id
(`deepseek-v4-pro`, `qwen3.8-max`, `glm-5.3`, `kimi-k2.7-code`,
`minimax-m2.7`) — the Qoder wire key (`dmodel`, `qfmodel`, ...) is
transport-only and never appears in configs, pickers, or catalogs. Tier
routers (`auto`, `ultimate`, `performance`, `efficient`, `lite`) are removed:
routing must pick concrete vendor models. Unverifiable models (Cantus) are not
listed.

**Qoder-reported capabilities are NOT trustworthy** (observed: stale
`max_input_tokens` floor on 1M models; `is_vl: true` on text-only
DeepSeek-V4-Pro/Flash and text-only GLM-5.3; `is_reasoning: false` on
always-thinking Kimi-K3; a 1M context option advertised on the 204,800-token
MiniMax-M2.7). The catalog's live data is used for keys/availability/wire
acceptance only; capabilities come from the vendor-verified overlay in
`src/providers/qoder-models.ts` (sources dated 2026-09-06):

- effort wire value = gateway-advertised ladder ∩ vendor-verified ladder;
- context pin = largest advertised option ≤ vendor-verified window;
- vision = vendor-verified (images are dropped for text-only targets);
- reasoning control kind: `efforts` / `toggle` / `always` (Kimi, GLM — send
  nothing, thinking cannot be disabled) / `none`.
- keys without a verified profile (tier routers, unknown vendors) keep
  Qoder-reported values, marked `verified: false`.

Internal capability normalization target:

```ts
type QoderModelCapability = {
  key: string; displayName: string;
  contextOptions: number[];   // wire-selectable, ≤ verified window
  contextWindow: number;      // vendor-verified when known
  reasoning: QoderReasoningControl;  // efforts|toggle|always|none (verified)
  wireReasoningEfforts: string[];    // advertised ∩ verified ladder
  vision: boolean;            // vendor-verified when known
  maxOutputTokens?: number; available: boolean; verified: boolean;
};
```

## Errors / retry contract (oracle: qodercli2api §8, adapted)

- Unique `request_id` per inference (duplicate → code 103, not auto-retryable).
- Upstream HTTP 401 → force re-exchange PAT once → one replay with fresh COSY
  headers (same logical `request_id` semantics as the reference proxy's
  attempt-1 refresh; our replay rebuilds the whole signed request).
- 402/quota and 429 surface as provider errors so the OpenCodex router can fail
  over; no endless retry. Transport-level retry policy stays OpenCodex-owned
  (existing pacing/429 layers).
- Cancellation: client AbortSignal must cancel the upstream fetch.
