# ТЗ: нативный Qoder Subscription Provider внутри OpenCodex

**Цель:** добавить Qoder как **внутренний источник inference-моделей** в наш fork OpenCodex v2.42.0.  
Qoder CLI, Qoder Agent SDK, Qoder harness, Qoder tools, memory, permissions и agent loop **не использовать**.

Наша архитектура:

```text
Codex Desktop / stock codex-rs harness
        ↓
OpenCodex GPT-facing contract
        ↓
GPT model + GPT reasoning effort router
        ↓
qoder-subscription provider
        ↓
конкретная Qoder model + её native reasoning/context
        ↓
Qoder inference
        ↓
OpenCodex AdapterEvents / Responses bridge
        ↓
Codex
```

Qoder нужен только как **subscription-backed model transport**.

---

## 1. Сначала скачать референсы

Создать отдельную read-only папку, **не vendor'ить эти проекты в наш repo**:

```bash
mkdir -p /tmp/qoder-refs
cd /tmp/qoder-refs

gh repo clone simonsmh/pi-provider-qoder
gh repo clone Liki4/qodercli2api
gh repo clone Hemilt0n/qoder-cpa
gh repo clone Sliverkiss/cpa-plugin
```

### Приоритет референсов

### A. `simonsmh/pi-provider-qoder` — ГЛАВНЫЙ референс

Почему:
- TypeScript;
- MIT;
- прямой provider, без Qoder CLI subprocess;
- Global + CN;
- PAT → job token;
- COSY signing;
- dynamic model catalog;
- reasoning/thinking;
- SSE streaming;
- структура близка к тому, что нужно встроить в Bun/OpenCodex.

Изучить прежде всего:

```text
src/cosy.ts
src/login.ts
src/pat.ts
src/models.ts
src/oauth.ts
src/stream.ts
src/transform.ts
src/thinking-parser.ts
src/qoder-encoding.ts
```

### B. `Liki4/qodercli2api` — ПРОТОКОЛЬНЫЙ oracle

Использовать для сравнения wire protocol и edge cases:

```text
auth.go
wasm.go
proxy.go
convert.go
openai.go
responses.go
docs/oauth.md
docs/inference-protocol.md
tests
```

ВАЖНО: проект AGPL. **Не копировать его код в наш MIT/OpenCodex fork.** Использовать как документацию/референс поведения.

Особенно проверить:
- unique `request_id`;
- auth refresh;
- reasoning/content/tool_calls;
- late usage frame;
- `event:finish`;
- error envelope;
- tool-call multi-turn;
- context_length.

### C. `Hemilt0n/qoder-cpa` — второй прямой Global-provider

Сравнить с `pi-provider-qoder`:
- PAT exchange;
- Global endpoint;
- COSY;
- model discovery;
- streaming;
- retry/refresh.

Нужен как независимое подтверждение, чтобы не привязаться к одному reverse-engineered проекту.

### D. `Sliverkiss/cpa-plugin`

Использовать **только как differential reference**, особенно `qoderwork/`, `STATUS.md`, `KNOWLEDGE.md`, `plan.md`.

Это в основном Qoder CN/QoderWork. Не переносить CN endpoints/encoding в Global вслепую.

Полезность: там зафиксирована история, что протокол Qoder менялся и разные клиенты/регионы могут использовать разные signing paths.

---

## 2. Главный принцип реализации

**НЕ делать второй proxy внутри OpenCodex.**

Не надо:

```text
OpenCodex → localhost:qodercli2api → Qoder
```

Нужно:

```text
OpenCodex → native qoder-subscription provider → Qoder
```

Provider обязан возвращать нейтральные OpenCodex events.  
Существующие `bridgeToResponsesSSE`, `ocxr1`, `ocx1`, Responses Lite, compaction v2, multi-agent v2 и tool translation остаются собственностью OpenCodex.

**Qoder не должен знать, что Codex-facing модель называется `gpt-5.6-sol`.**

---

## 3. Не использовать

Категорически не использовать в runtime:

- Qoder CLI subprocess;
- Qoder Agent SDK;
- Qoder agent/system prompt;
- Qoder tools;
- Qoder permissions;
- Qoder memory;
- Qoder subagents;
- Qoder session history как source of truth;
- Qoder auto/ultimate/performance router, если наш GPT router выбрал конкретную модель;
- отдельный OpenAI Responses server для Qoder.

Нам нужны только:

```text
auth
model discovery
request signing/encoding
raw model inference
reasoning
text
tool_calls
usage/errors
```

---

## 4. Сначала проверить ТЕКУЩИЙ Global protocol

Референсы расходятся по деталям:

- одни используют `api2.qoder.sh`;
- более новые direct-provider реализации используют `api3.qoder.sh`;
- старый qodercli2api опирается на `prepareInferRequest` WASM;
- новые provider implementations умеют COSY signing напрямую.

Поэтому **не хардкодить протокол по одному README**.

Перед основным кодом сделать минимальный probe текущего Global Qoder с собственным PAT:

1. PAT exchange;
2. user info;
3. model list;
4. один text inference;
5. reasoning inference;
6. tool call.

Зафиксировать в коротком `QODER_PROTOCOL_CURRENT.md`:

```text
working auth endpoint
working model-list endpoint
working inference endpoint
required headers
body encoding
signing path
SSE envelope format
401 behavior
model key format
```

Если чистый TypeScript COSY path из `pi-provider-qoder` работает — **предпочесть его**.  
WASM тащить только если текущий Global endpoint реально без него не работает.

Endpoints должны быть provider config/defaults, а не размазаны по коду.

---

## 5. Authentication

### P0: PAT first

Официальный Qoder поддерживает Personal Access Token для automation.  
Первый рабочий вариант provider сделать через:

```text
QODER_PERSONAL_ACCESS_TOKEN
```

PAT:
- никогда не писать в config-generated catalog;
- никогда не логировать;
- не принимать через CLI argv;
- читать из env/secret config существующим способом OpenCodex.

По рабочим direct-provider reference:

```text
PAT
→ jobToken/exchange
→ short-lived job token
→ inference auth
```

Нужно:
- cache token + expiry;
- refresh/re-exchange заранее;
- при upstream 401: один re-auth + один replay;
- никакого бесконечного retry;
- credential state не смешивать с Codex thread state.

### P1 optional

После рабочего PAT можно добавить browser/device flow. Это **не должно блокировать P0**.

---

## 6. Dynamic model discovery

Не хардкодить возможности Qoder моделей из README.

Qoder официально меняет:
- model list;
- reasoning options;
- context options;
- credit factors;
- availability

server-side.

Provider должен уметь получить live model catalog и нормализовать его во внутреннюю структуру:

```ts
type QoderModelCapability = {
  key: string
  displayName: string
  contextOptions: number[]
  reasoningEfforts: string[]
  vision: boolean
  maxOutputTokens?: number
  available: boolean
}
```

Нужны:
- TTL cache;
- stale-cache fallback при временной ошибке discovery;
- optional static fallback только как аварийный вариант;
- internal model key хранить отдельно от display name.

**Qoder catalog не должен менять Codex-facing GPT catalog.**

Он используется только для проверки eligibility внутреннего target.

---

## 7. Direct models, не Qoder tier router

Наш router должен выбирать конкретный Qoder model key.

Предпочтительно:

```text
Kimi-K3
DeepSeek-V4-Pro
DeepSeek-V4-Flash
GLM
Qwen
MiniMax
```

а не:

```text
auto
performance
ultimate
```

Tier routing допускается только если пользователь явно настроит его как target.

Причина:

```text
GPT effort → наш deterministic router → конкретная Qoder model
```

а не:

```text
GPT effort → наш router → Qoder auto-router → неизвестная model
```

---

## 8. Provider boundary

Qoder-provider не должен содержать GPT-specific logic.

На вход provider получает уже выбранный target:

```ts
{
  provider: "qoder-subscription",
  model: "<qoder-key>",
  reasoning: "<qoder-native-effort | none>",
  contextLimit: ...,
  messages: ...,
  tools: ...
}
```

Например:

```text
gpt-5.6-sol + xhigh
→ GPT router
→ qoder-subscription / DeepSeek-V4-Pro / high
```

Сам Qoder provider **не знает**, почему выбран DeepSeek и что клиент просил GPT Sol.

---

## 9. Request conversion

Не создавать второй Responses implementation.

Рекомендуемый путь:

1. Использовать существующую OpenCodex parsed conversation.
2. Перевести только transport-facing форму в Qoder/OpenAI-chat style.
3. Отправить:
   - system;
   - messages;
   - images, если target поддерживает;
   - function tools;
   - tool outputs;
   - tool_choice;
   - provider-native reasoning effort;
   - context_length;
   - max_tokens, если требуется.
4. Полученный stream превратить в существующие OpenCodex AdapterEvents.

Если возможно без уродливого coupling — **переиспользовать общий parser OpenAI-chat chunks**.  
Не копировать второй раз parsing `delta.content`, `reasoning_content`, `tool_calls`.

Если `openai-chat.ts` слишком tightly coupled к HTTP transport — вынести общий chunk parser в маленький shared helper и использовать его обоими adapters.

---

## 10. Reasoning

GPT effort и Qoder effort — разные namespaces.

Router уже решает:

```text
GPT effort → target model → Qoder-native effort
```

Provider обязан отправлять **только Qoder-native value**.

Если target не имеет configurable reasoning:

```text
reasoning parameter НЕ отправлять вообще
```

Не отправлять `"none"`, если Qoder-модель ожидает отсутствие поля.

Upstream:

```text
delta.reasoning_content
```

должен стать обычным OpenCodex reasoning event.

Дальше existing OpenCodex сам делает:
- reasoning item;
- summary;
- `ocxr1`;
- replay/state.

**Не хранить Qoder-specific reasoning blob в Codex-facing state.**

---

## 11. Tools

Qoder-модель только **выбирает tool call**.

Она не должна исполнять Qoder tools.

На upstream передаются только tools, которые пришли из нашего Codex/OpenCodex harness:

```text
shell/apply_patch
MCP
tool_search lowering
custom/function tools
и т.д.
```

Нужно проверить:
- streaming tool arguments;
- несколько tool calls;
- tool_call_id;
- role=`tool`;
- следующий turn после tool result;
- reasoning + tool_calls в одном ответе.

Исполнение всегда остаётся в Codex harness.

---

## 12. Sessions / state

Не допускать скрытого Qoder harness state.

Source of truth:

```text
Codex history
previous_response_id
OpenCodex state
ocxr1
ocx1
```

Qoder `session_id` считать transport metadata.

По умолчанию предпочтительно генерировать отдельный UUID на inference request.  
Если current Qoder protocol требует стабильный `session_id` для tool round-trip — сначала доказать это тестом и только потом связать его с Codex thread.

Нельзя полагаться на скрытую Qoder conversation history.

---

## 13. SSE / terminal semantics

Поддержать оба наблюдаемых варианта:
- envelope, где `body` содержит JSON OpenAI chunk;
- direct OpenAI-like chunk, если текущий Global endpoint его использует.

Нормализовать:

```text
delta.content
delta.reasoning_content
delta.tool_calls
finish_reason
usage
error/statusCodeValue
event:finish
```

ВАЖНО: часть реализаций получает `usage` **после** `finish_reason`.

Не закрывать внутренний stream преждевременно.  
Финализировать после корректного terminal event / `event:finish`, либо после доказанного EOF policy.

---

## 14. Errors / retry / concurrency

Нужно:

- unique `request_id` на каждый inference;
- replay-safe UUID generation;
- 401 → re-auth один раз → retry один раз;
- 429/quota → нормальная provider error, чтобы OpenCodex router мог сделать fallback;
- 402/credit exhaustion → deterministic provider-unavailable/quota classification;
- upstream malformed SSE → controlled failure;
- AbortSignal/cancel от Codex → закрыть Qoder HTTP stream;
- timeout/stall использовать существующую OpenCodex policy.

Проверить минимум 5 параллельных inference requests.

Если signer имеет mutable/non-thread-safe state — сериализовать **только signing step**, а сами HTTP streams оставить параллельными.

---

## 15. Context

Qoder target capability используется только внутри routing/admission.

Например target имеет:

```text
200K / 400K / 1M
```

Router выбирает подходящий Qoder context option.

Но это **не изменяет** native GPT catalog profile.

Проверять перед отправкой:

```text
effective upstream input <= selected Qoder context
```

Если не помещается:
1. другой eligible target/context option;
2. существующий OpenCodex/Codex compaction path;
3. controlled context overflow.

Не делать silent truncation history внутри Qoder provider.

---

## 16. Identity isolation

В Codex-visible данных не должны появляться:

```text
qoder
api3.qoder.sh
kmodel_latest
dmodel
MiniMax
Kimi
DeepSeek
Qwen
GLM
COSY
jobToken
```

кроме внутренних debug logs, которые никогда не идут клиенту.

Проверить:
- errors;
- SSE events;
- model fields;
- tool metadata;
- reasoning items;
- usage;
- subagent turns;
- compaction;
- catalog.

Provider error перед client-facing layer должен проходить существующую sanitization policy OpenCodex.

---

## 17. Файловая архитектура

Сначала следовать текущим conventions OpenCodex. Не создавать искусственную подсистему, если уже есть provider abstractions.

Ориентировочно логика должна разделяться так:

```text
qoder auth
qoder signing/encoding
qoder model discovery
qoder request transport
qoder SSE parsing
qoder provider adapter
```

Не смешивать это в одном 1500-line файле.

Предпочтительно получить модули порядка:

```text
auth
catalog
signing
protocol/transport
stream parser
provider registration
```

Но реальные filenames выбрать после изучения существующей структуры OpenCodex.

---

## 18. Что НЕ трогать

Без доказанной необходимости не менять:

- Codex Desktop;
- codex-rs;
- GPT catalog virtualization;
- `bridgeToResponsesSSE`;
- `ocxr1`;
- `ocx1`;
- compaction v2;
- multi-agent v2;
- tool_search/custom-tool lowering;
- current identity fixes;
- обычные Kimi/MiniMax/DeepSeek direct providers.

Qoder должен добавиться как **ещё один internal provider backend**, а не менять архитектуру всего proxy.

---

## 19. Config

Интегрировать в существующую config schema OpenCodex, а не придумывать отдельный конфиг-движок.

Минимально provider должен иметь:

```text
provider type/id = qoder-subscription
region = global
auth = PAT env reference
optional endpoint overrides
optional catalog TTL
```

GPT×effort router должен иметь возможность target'ить:

```text
qoder-subscription/<qoder-model-key>
```

и передавать provider-native reasoning/context profile.

Secrets в catalog/config dump не сериализовать.

---

## 20. Tests

### Unit

Обязательно:

1. PAT exchange parsing.
2. Token expiry / re-auth.
3. Signing/encoding test vectors.
4. Unique request_id.
5. Model-list parser.
6. Capability normalization.
7. Request conversion:
   - system;
   - text;
   - image;
   - tools;
   - tool output;
   - reasoning;
   - context.
8. SSE:
   - text;
   - reasoning;
   - fragmented tool args;
   - multiple tool calls;
   - usage after finish_reason;
   - error envelope;
   - malformed frame.
9. Cancel/AbortSignal.
10. Concurrent signing/calls.

### Integration against mocked Qoder

Проверить:

```text
OpenCodex parsed request
→ qoder provider
→ mock Qoder SSE
→ AdapterEvents
→ existing Responses bridge
```

Не snapshot'ить secrets/signatures.

### Live opt-in tests

Только при наличии env PAT:

```text
QODER_PERSONAL_ACCESS_TOKEN
```

Прогнать:
- simple text;
- Kimi reasoning;
- DeepSeek reasoning;
- MiniMax no-reasoning-param;
- one tool call;
- multi-turn tool result;
- model discovery;
- 5 concurrent calls.

Live tests по умолчанию skip.

---

## 21. End-to-end acceptance в нашей системе

После provider tests:

### A. GPT routing

Проверить, что разные GPT efforts реально могут уйти в разные Qoder targets:

```text
gpt-5.6-sol + low   → Qoder target A
gpt-5.6-sol + xhigh → Qoder target B
```

При этом Codex-facing `model` остаётся `gpt-5.6-sol`.

### B. Reasoning

```text
Qoder reasoning_content
→ OpenCodex reasoning
→ Responses reasoning item
→ continuation
```

### C. Tools

```text
Codex tool schema
→ Qoder
→ tool_call
→ Codex executes
→ tool result
→ Qoder continuation
```

### D. Compaction

Длинный routed thread через Qoder переживает `ocx1` compaction без Qoder-specific state.

### E. Multi-agent V2

Parent/child через Qoder provider работает так же, как уже проверенный routed path.

### F. No OpenAI

Во время теста:
- 0 запросов к OpenAI/ChatGPT;
- Qoder + локальный OpenCodex only.

---

## 22. Лицензии

Приоритет для заимствования структуры/идей:

1. `pi-provider-qoder` — MIT, предпочтительный кодовый reference.
2. `qoder-cpa` — использовать как независимый протокольный reference после проверки лицензии конкретного файла/repo.
3. `qodercli2api` — AGPL: **не копировать код**, только читать поведение/документацию/test cases.
4. `cpa-plugin` — проверить LICENSE конкретного qoderwork subtree перед копированием; лучше использовать как reference.

Если понадобится third-party WASM — отдельно проверить `NOTICE` и условия распространения.  
Предпочтение: собственный TypeScript signer, если текущий Global protocol это позволяет.

---

## 23. Важный нюанс: Qoder protocol drift

Нельзя считать ни один reverse-engineered endpoint вечным.

Поэтому:
- endpoints configurable;
- model discovery dynamic;
- auth/signing изолированы;
- transport version не протекает в остальной OpenCodex;
- при update ломается только `qoder-subscription`, не GPT router/harness.

Если `api3` завтра сменится — меняем один provider transport.

---

## 24. Порядок работы

### Phase 0 — Reference + live verification
- скачать refs;
- прочитать primary files;
- проверить current Global PAT/model-list/inference;
- создать `QODER_PROTOCOL_CURRENT.md`.

### Phase 1 — Provider core
- auth;
- token cache;
- signing/encoding;
- model discovery;
- raw text stream.

### Phase 2 — Full model semantics
- reasoning;
- images;
- tool calls;
- usage;
- errors;
- cancellation.

### Phase 3 — OpenCodex integration
- provider registration/config;
- target selection;
- reuse AdapterEvent bridge;
- GPT×effort router target.

### Phase 4 — tests
- unit;
- mock integration;
- opt-in live;
- E2E Codex.

### Phase 5 — cleanup
- убрать probe/debug;
- убедиться, что secrets не логируются;
- проверить diff на отсутствие Qoder harness logic;
- документация config/example.

---

## 25. Definition of Done

Работа считается законченной, когда:

- Qoder CLI **не установлен и не запускается**;
- Qoder Agent SDK не используется;
- один PAT даёт native provider auth;
- live model list читается напрямую;
- конкретная Qoder model выбирается нашим router;
- reasoning/context mapping provider-native;
- text/reasoning/tools/usage стримятся корректно;
- Codex выполняет tools своим harness;
- `ocxr1`, `ocx1`, multi-agent и Responses остаются OpenCodex-side;
- Qoder model/provider ID не протекает в Codex-facing contract;
- нет OpenAI requests;
- все новые tests зелёные;
- существующие OpenCodex tests зелёные;
- TypeScript/typecheck зелёный;
- нет второго localhost proxy/subprocess.

---

## 26. Отчёт после реализации

В конце сообщить:

1. какие reference repos реально использованы;
2. какой Global endpoint/auth path оказался рабочим на текущую дату;
3. использован pure TS COSY или WASM и почему;
4. какие файлы OpenCodex добавлены/изменены;
5. config example;
6. live discovered model list;
7. результаты unit/integration/live tests;
8. E2E GPT→Qoder routing result;
9. есть ли хоть одна функция, где Qoder harness/state всё ещё участвует;
10. известные риски/protocol drift.

**Не делать архитектурный rewrite. Не использовать subagents. Делать минимальный native provider внутри текущего OpenCodex fork.**
