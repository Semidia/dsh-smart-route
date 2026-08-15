// dsh-smart-route — Host 半区
//
// 智能路由：注册一个虚拟 provider 路由 `smart-route`，在链上的真实
// provider 之间做自动回退。
//
// 与 polyglot 的关键差异：
//   1. 全错误降级 —— 任何 error finish（含 4xx INVALID_REQUEST、AUTH、
//      HTTP_xxx 等）都尝试切下一家。
//   2. 停用开关 —— settings 段 enabled 字段 + RPC setEnabled，可一键停用。
//   3. 模型列表干净 —— 只注册一个虚拟 provider，不注册 configurable
//      providers。
//   4. 对话栏按钮 —— client 半区在 composer 工具行提供状态按钮。
//   5. 渠道级 baseUrl 覆盖 —— 每个渠道可声明 baseUrl/apiKeyEnv；声明了
//      baseUrl 的渠道走内置 OpenAI 兼容分派（fetch + SSE），未声明的
//      复用 DSH 已注册 provider（ctx.llm.stream 二次分派）。
//   6. 多链管理 —— RPC 支持新建链 / 删除链 / 切换默认链。
//
// 渠道链配置（settings 段 smart-route）：
//   enabled: true
//   defaultChain: 'default'
//   chains:
//     default:
//       - provider: deepseek-official
//         model: deepseek-v4-flash
//       - provider: yunzhou
//         model: 'DeepSeek-V4-Flash[free]'
//       - provider: custom
//         model: gpt-4o-mini
//         baseUrl: https://example.com/v1
//         apiKeyEnv: MY_KEY
//   cooldown: { baseMs, maxMs, factor, jitterRatio }

import { LlmAdapter, LlmError, CallId, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';

export const name = 'dsh-smart-route';
// settings 是硬依赖：插件在 settings 服务就绪后才 activate，注册才能被
// client 的 /api/settings.describe 看到（与官方 sampling-sliders 一致）。
export const inject = ['llm', 'connection', 'settings'];
const NS = settingsNamespace('smart-route');
const VIRTUAL_PROVIDER = 'smart-route';

const entrySchema = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    baseUrl: z.string(),
    apiKeyEnv: z.string(),
});
const cooldownSchema = z.object({
    baseMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(10000),
    maxMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(900000),
    factor: z.number().min(1).max(10).default(3),
    jitterRatio: z.number().min(0).max(1).default(0.1),
});
export const Config = z.object({
    enabled: z.boolean().default(true),
    defaultChain: z.string().default('default'),
    // 默认一条链：组合未提供任何 chains 时也能启动（host 端 apply 不再抛错）。
    // 链首渠道与当前环境的默认 provider 一致；用户可在设置卡里改。
    chains: z.dict(z.array(entrySchema)).default({
        default: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    }),
    cooldown: cooldownSchema.default({}),
});

/** 渠道冷却跟踪：失败后跳过该渠道一段时间。 */
class ProviderCooldown {
    #config;
    #now;
    #state = new Map();
    constructor(config, now = Date.now) {
        this.#config = config;
        this.#now = now;
    }
    cooling(provider) {
        const entry = this.#state.get(provider);
        return entry !== undefined && entry.until > this.#now();
    }
    recordFailure(provider) {
        const previous = this.#state.get(provider);
        const consecutive = (previous?.consecutive ?? 0) + 1;
        const { baseMs, maxMs, factor, jitterRatio } = this.#config();
        const backoff = Math.min(maxMs, baseMs * Math.pow(factor, consecutive - 1));
        const jitter = backoff * jitterRatio * (Math.random() * 2 - 1);
        this.#state.set(provider, { until: this.#now() + Math.max(0, backoff + jitter), consecutive });
    }
    recordSuccess(provider) {
        this.#state.delete(provider);
    }
    status(now) {
        const out = {};
        for (const [provider, entry] of this.#state) {
            const remaining = entry.until - now;
            if (remaining > 0) out[provider] = Math.ceil(remaining / 1000);
        }
        return out;
    }
}

// ── 内置 OpenAI 兼容分派（渠道声明了 baseUrl 时使用）─────────────────
// 最小实现：serialize 消息 → fetch SSE → translate 为 StreamChunk。
function flattenText(blocks) {
    return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}
function serializeMessages(messages) {
    const wire = [];
    for (const message of messages) {
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            const text = flattenText(message.content);
            const toolCalls = message.content.filter((block) => block.type === 'tool-call').map((block) => ({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: block.arguments },
            }));
            wire.push({
                role: 'assistant',
                content: text,
                ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
            });
            continue;
        }
        const toolResults = message.content.filter((block) => block.type === 'tool-result');
        const text = flattenText(message.content);
        if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
        for (const result of toolResults) {
            wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' });
        }
    }
    return wire;
}
function serializeRequest(options) {
    const messages = [];
    if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
    messages.push(...serializeMessages(options.messages));
    const tools = options.tools?.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop !== undefined ? { stop: options.stop } : {},
    };
}
function mapFinishReason(reason) {
    switch (reason) {
        case 'stop': return { kind: 'stop' };
        case 'tool_calls': return { kind: 'tool-calls' };
        case 'length': return { kind: 'max-tokens' };
        default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
    }
}
function mapUsage(usage) {
    if (!usage) return undefined;
    const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0 && cacheRead === undefined && reasoning === undefined) return undefined;
    return {
        inputTokens: inputTokens - (cacheRead ?? 0),
        outputTokens,
        ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
        ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
    };
}
/** 消费 SSE data payloads（[DONE] 终止）并产出 StreamChunk。 */
async function* translate(payloads) {
    let nextIndex = 0;
    let textBlock;
    const toolBlocks = new Map();
    const order = [];
    let pendingFinish;
    let pendingUsage;
    function open(kind) {
        const block = { index: nextIndex++, kind, text: '' };
        order.push(block);
        return block;
    }
    for await (const payload of payloads) {
        if (payload === '[DONE]') {
            for (const block of order) {
                if (block.kind === 'text') yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } };
                else if (block.kind === 'tool-call') yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text } };
            }
            if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
            const reason = pendingFinish ?? { kind: 'stop' };
            yield {
                type: 'finish',
                reason: reason.kind === 'stop' && order.length === 0 ? {
                    kind: 'error',
                    failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
                } : reason,
            };
            return;
        }
        let chunk;
        try { chunk = JSON.parse(payload); }
        catch { throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE'); }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
            const delta = choice.delta ?? {};
            const content = typeof delta.content === 'string' ? delta.content : undefined;
            if (typeof content === 'string' && content.length > 0) {
                if (!textBlock) {
                    textBlock = open('text');
                    yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
                }
                textBlock.text += content;
                yield { type: 'text-delta', index: textBlock.index, text: content };
            }
            const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const call of calls) {
                const callIndex = typeof call.index === 'number' ? call.index : 0;
                let block = toolBlocks.get(callIndex);
                if (!block) {
                    block = open('tool-call');
                    toolBlocks.set(callIndex, block);
                    yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                }
                if (typeof call.id === 'string') block.callId = call.id;
                const fn = call.function ?? {};
                if (typeof fn.name === 'string') block.name = fn.name;
                const fragment = typeof fn.arguments === 'string' ? fn.arguments : '';
                block.text += fragment;
                yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? ''), ...block.name !== undefined ? { name: block.name } : {}, argumentsDelta: fragment };
            }
            if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined && typeof chunk.usage === 'object') {
            const mapped = mapUsage(chunk.usage);
            if (mapped) pendingUsage = mapped;
        }
    }
    throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}
/** 解析 SSE 文本流为 data payloads（[DONE] 终止）。 */
async function* parseSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).replace(/\r$/, '');
                buffer = buffer.slice(idx + 1);
                if (line.startsWith('data:')) {
                    const payload = line.slice(5).trim();
                    if (payload) yield payload;
                }
            }
        }
        const tail = buffer.trim();
        if (tail.startsWith('data:')) {
            const payload = tail.slice(5).trim();
            if (payload) yield payload;
        }
    } finally {
        reader.releaseLock();
    }
}
/** 内置 OpenAI 兼容渠道的流式请求。 */
async function* openAiCompatStream(options, entry, apiKey) {
    const body = serializeRequest(options);
    const headers = {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    let response;
    try {
        response = await fetch(`${entry.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', headers, body: JSON.stringify(body),
        });
    }
    catch (error) {
        if (options.signal?.aborted) throw error;
        throw new LlmError(`Provider API request to ${entry.baseUrl} failed`, 'TRANSPORT', { cause: error });
    }
    if (!response.ok) {
        let message = `Provider API error (HTTP ${response.status})`;
        try {
            const parsed = await response.json();
            if (parsed?.error?.message) message = parsed.error.message;
        }
        catch { /* non-JSON */ }
        const code = response.status === 401 || response.status === 403 ? 'AUTH'
            : response.status === 429 ? 'RATE_LIMIT'
                : response.status === 400 ? 'INVALID_REQUEST'
                    : response.status >= 500 ? 'SERVER' : `HTTP_${response.status}`;
        throw new LlmError(message, code, { status: response.status });
    }
    if (!response.body) throw new LlmError('Provider API returned no response body', EMPTY_RESPONSE_CODE);
    yield* translate(parseSse(response.body));
}
/** 从 launch 环境读取 API key（按 apiKeyEnv）。 */
function readApiKey(launchEnv, apiKeyEnv) {
    if (!apiKeyEnv) return '';
    const hit = launchEnv.get(apiKeyEnv);
    return hit && typeof hit.value === 'string' ? hit.value : '';
}

/** 智能路由适配器：按链顺序尝试真实 provider，任何错误都切下一家。 */
class SmartRouteAdapter extends LlmAdapter {
    #options;
    #cooldown;
    constructor(options) {
        super();
        this.#options = options;
        this.#cooldown = new ProviderCooldown(options.cooldown, options.now ?? Date.now);
    }
    get cooldown() {
        return this.#cooldown;
    }
    providerInfo(provider) {
        return { id: provider, name: '智能路由' };
    }
    providerRetryPolicy(_provider) {
        return undefined;
    }
    listModels(provider) {
        return Promise.resolve([{ provider, id: 'auto', name: '自动路由', inputModalities: ['text'] }]);
    }
    resolveModel(provider, model, _signal) {
        const chain = this.#options.chain();
        const first = chain.entries[0];
        if (first === undefined) {
            throw new LlmError('dsh-smart-route: 链上没有配置任何渠道', 'NO_PROVIDER');
        }
        const resolved = this.#options.resolveModelInfo(first.provider, first.model);
        if (resolved === undefined) {
            return Promise.resolve({
                provider, id: model, name: model, inputModalities: ['text'],
                context: { contextWindow: this.#options.defaultContextWindow() },
                defaultMaxTokens: this.#options.defaultMaxTokens(),
            });
        }
        return Promise.resolve(resolved);
    }
    async *stream(options) {
        const state = this.#options.state();
        if (!state.enabled) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: '智能路由已停用：请在对话栏按钮或设置中启用', code: 'DISABLED' } } };
            return;
        }
        const chain = this.#options.chain();
        const entries = chain.entries;
        if (entries.length === 0) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'dsh-smart-route: 链上没有配置任何渠道', code: 'NO_PROVIDER' } } };
            return;
        }
        let lastFailure;
        let attempt = 0;
        for (const entry of entries) {
            attempt += 1;
            const key = entry.baseUrl ? `${entry.provider}@${entry.baseUrl}` : entry.provider;
            if (this.#cooldown.cooling(key)) {
                this.#options.logger?.info(`dsh-smart-route: ${key} 冷却中 — 跳过`);
                continue;
            }
            const outcome = yield* this.#tryEntry(options, entry, attempt);
            if (outcome.kind === 'served') {
                this.#cooldown.recordSuccess(key);
                if (outcome.usage) yield { type: 'usage', usage: outcome.usage };
                yield { type: 'finish', reason: outcome.finish };
                return;
            }
            if (outcome.terminal) {
                if (outcome.usage) yield { type: 'usage', usage: outcome.usage };
                yield { type: 'finish', reason: outcome.finish };
                return;
            }
            lastFailure = outcome.finish;
        }
        const reason = lastFailure ?? {
            kind: 'error',
            failure: { message: 'dsh-smart-route: 链上所有渠道均失败或冷却中', code: 'NO_PROVIDER' },
        };
        yield { type: 'finish', reason };
    }
    async *#tryEntry(options, entry, attempt) {
        let forwardedContent = false;
        let usage;
        const key = entry.baseUrl ? `${entry.provider}@${entry.baseUrl}` : entry.provider;
        try {
            let stream;
            if (entry.baseUrl) {
                const apiKey = readApiKey(this.#options.launchEnv(), entry.apiKeyEnv);
                stream = openAiCompatStream(options, entry, apiKey);
            }
            else {
                stream = this.#options.dispatch({ ...options, provider: entry.provider, model: entry.model });
            }
            for await (const chunk of stream) {
                if (chunk.type === 'usage') { usage = chunk.usage; continue; }
                if (chunk.type === 'finish') {
                    const finish = chunk.reason;
                    const ok = finish.kind !== 'error' && finish.kind !== 'aborted';
                    if (ok) return { kind: 'served', finish, usage };
                    if (finish.kind === 'aborted') return { kind: 'failed', terminal: true, finish, usage };
                    const failure = finish.failure;
                    this.#cooldown.recordFailure(key);
                    this.#options.logger?.info(`dsh-smart-route: ${key} 失败(${failure?.code ?? '?'}: ${failure?.message ?? ''}) — 尝试下一家`);
                    return { kind: 'failed', terminal: false, finish, usage };
                }
                forwardedContent = true;
                yield chunk;
            }
            return { kind: 'served', finish: { kind: 'stop' }, usage };
        }
        catch (error) {
            const failure = error instanceof LlmError
                ? { message: error.message, code: error.code }
                : { message: error && error.message ? error.message : String(error), code: 'TRANSPORT' };
            if (forwardedContent) {
                this.#options.logger?.info(`dsh-smart-route: ${key} 已流式输出后出错 — 不回退`);
                return { kind: 'failed', terminal: true, finish: { kind: 'error', failure }, usage };
            }
            this.#cooldown.recordFailure(key);
            this.#options.logger?.info(`dsh-smart-route: ${key} 请求失败(${failure.code}: ${failure.message}) — 尝试下一家`);
            return { kind: 'failed', terminal: false, finish: { kind: 'error', failure }, usage };
        }
    }
}

export function apply(ctx, raw) {
    const config = Config(raw);
    let current = () => config;
    let lastRaw;
    let lastGood;
    const state = () => {
        const raw = current();
        if (raw === lastRaw && lastGood !== undefined) return lastGood;
        try {
            const next = resolveState(raw);
            lastRaw = raw;
            lastGood = next;
            return next;
        }
        catch (error) {
            if (lastGood === undefined) throw error;
            lastRaw = raw;
            ctx.logger.error('dsh-smart-route: settings 段无效，保留上一次可用配置');
            ctx.logger.error(error);
            return lastGood;
        }
    };
    state();

    const launchEnv = () => launchEnvironmentOf(ctx);
    const chainEntries = (name) => {
        const s = state();
        const active = name in s.chains ? name : (s.defaultChain in s.chains ? s.defaultChain : Object.keys(s.chains)[0]);
        return { name: active, entries: s.chains[active] ?? [] };
    };
    const cooldownConfig = () => {
        const raw = current();
        return {
            baseMs: raw.cooldown?.baseMs ?? 10000,
            maxMs: raw.cooldown?.maxMs ?? 900000,
            factor: raw.cooldown?.factor ?? 3,
            jitterRatio: raw.cooldown?.jitterRatio ?? 0.1,
        };
    };
    const resolveModelInfo = (provider, model) => {
        try { return ctx.llm.resolveModelInfo(provider, model); }
        catch { return undefined; }
    };

    const router = new SmartRouteAdapter({
        state: () => state(),
        chain: () => chainEntries(current().defaultChain),
        dispatch: (options) => ctx.llm.stream(options),
        cooldown: cooldownConfig,
        resolveModelInfo,
        defaultContextWindow: () => 1000000,
        defaultMaxTokens: () => 256000,
        launchEnv,
        logger: ctx.logger,
    });
    ctx.llm.registerAdapter([VIRTUAL_PROVIDER], router);

    // 注册 settings namespace（与官方 sampling-sliders 一致）：
    // settings 已通过 inject 硬依赖就绪，直接在调用方 fiber 上 register，
    // 确保 client 的 /api/settings.describe 能看到该 namespace。
    const settingsScope = ctx.settings.register(NS, Config, { applies: 'live', base: config });
    current = () => settingsScope.get();
    settingsScope.watch(() => state());

    // ── loopback RPC ─────────────────────────────────────────────
    // 通过 settings 服务（2 参数 API）读写 smart-route 段。
    const scopeOf = () => ctx.get('settings');
    const readSection = () => {
        const scope = scopeOf();
        if (scope === undefined) return null;
        const s = scope.get(NS);
        return s && typeof s === 'object' ? s : {};
    };
    const writeSection = async (next) => {
        const scope = scopeOf();
        if (scope === undefined) throw new Error('settings 服务不可用');
        await scope.replace(NS, next);
    };

    ctx.connection.rpc.handle('/dsh-smart-route', async (endpoint, payload) => {
        try {
            if (endpoint === 'status') {
                const s = state();
                const chain = chainEntries(s.defaultChain);
                const registered = new Set(ctx.llm.listProviders().map((p) => p.id));
                const entries = chain.entries.map((e) => ({
                    provider: e.provider,
                    model: e.model,
                    ...e.baseUrl ? { baseUrl: e.baseUrl } : {},
                    ...e.apiKeyEnv ? { apiKeyEnv: e.apiKeyEnv } : {},
                    registered: !e.baseUrl ? registered.has(e.provider) : true,
                }));
                return {
                    ok: true,
                    value: {
                        enabled: s.enabled,
                        defaultChain: chain.name,
                        chains: s.chains,
                        entries,
                        cooldown: router.cooldown.status(Date.now()),
                        providers: ctx.llm.listProviders().map((p) => p.id),
                        virtualProvider: VIRTUAL_PROVIDER,
                    },
                };
            }
            if (endpoint === 'setEnabled') {
                const enabled = payload && typeof payload.enabled === 'boolean' ? payload.enabled : !state().enabled;
                const base = readSection() ?? {};
                await writeSection({ ...base, enabled });
                return { ok: true, value: { enabled } };
            }
            if (endpoint === 'setChain') {
                const s = state();
                const name = payload && typeof payload.name === 'string' ? payload.name : null;
                const entries = payload && Array.isArray(payload.entries) ? payload.entries : null;
                if (!name || !entries) return { ok: false, error: { code: 'bad-request', message: 'setChain 需要 name 与 entries' } };
                const base = readSection() ?? {};
                const chains = { ...(base.chains ?? s.chains) };
                chains[name] = entries.map((e) => ({
                    provider: String(e.provider || '').trim(),
                    model: String(e.model || '').trim(),
                    ...e.baseUrl ? { baseUrl: String(e.baseUrl).trim() } : {},
                    ...e.apiKeyEnv ? { apiKeyEnv: String(e.apiKeyEnv).trim() } : {},
                }));
                const next = { ...base, chains };
                if (name) next.defaultChain = name;
                await writeSection(next);
                return { ok: true, value: { chains: next.chains, defaultChain: next.defaultChain } };
            }
            if (endpoint === 'addChain') {
                const s = state();
                const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
                if (!name) return { ok: false, error: { code: 'bad-request', message: 'addChain 需要非空 name' } };
                const base = readSection() ?? {};
                const chains = { ...(base.chains ?? s.chains) };
                if (name in chains) return { ok: false, error: { code: 'exists', message: `链 "${name}" 已存在` } };
                chains[name] = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }];
                await writeSection({ ...base, chains });
                return { ok: true, value: { chains } };
            }
            if (endpoint === 'removeChain') {
                const s = state();
                const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
                const base = readSection() ?? {};
                const chains = { ...(base.chains ?? s.chains) };
                if (!(name in chains)) return { ok: false, error: { code: 'missing', message: `链 "${name}" 不存在` } };
                if (Object.keys(chains).length <= 1) return { ok: false, error: { code: 'last-chain', message: '至少保留一条链' } };
                delete chains[name];
                let defaultChain = base.defaultChain ?? s.defaultChain;
                if (defaultChain === name) defaultChain = Object.keys(chains)[0];
                await writeSection({ ...base, chains, defaultChain });
                return { ok: true, value: { chains, defaultChain } };
            }
            if (endpoint === 'setDefaultChain') {
                const s = state();
                const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
                const base = readSection() ?? {};
                const chains = base.chains ?? s.chains;
                if (!(name in chains)) return { ok: false, error: { code: 'missing', message: `链 "${name}" 不存在` } };
                await writeSection({ ...base, defaultChain: name });
                return { ok: true, value: { defaultChain: name } };
            }
            if (endpoint === 'setCooldown') {
                const patch = {};
                if (payload && typeof payload.baseMs === 'number') patch.baseMs = payload.baseMs;
                if (payload && typeof payload.maxMs === 'number') patch.maxMs = payload.maxMs;
                if (payload && typeof payload.factor === 'number') patch.factor = payload.factor;
                if (payload && typeof payload.jitterRatio === 'number') patch.jitterRatio = payload.jitterRatio;
                const base = readSection() ?? {};
                await writeSection({ ...base, cooldown: { ...(base.cooldown ?? {}), ...patch } });
                return { ok: true, value: { cooldown: { ...(base.cooldown ?? {}), ...patch } } };
            }
            return { ok: false, error: { code: 'bad-request', message: 'unknown endpoint ' + JSON.stringify(endpoint) } };
        }
        catch (error) {
            return { ok: false, error: { code: 'internal', message: error && error.message ? error.message : String(error) } };
        }
    }, { authority: 'loopback' });
}

/** Resolve raw config into a normalized state. */
function resolveState(raw) {
    const chainNames = Object.keys(raw.chains ?? {});
    if (chainNames.length === 0) throw new Error('dsh-smart-route: 至少需要一条链');
    if (!(raw.defaultChain in raw.chains)) {
        throw new Error(`dsh-smart-route: defaultChain "${raw.defaultChain}" 不是已配置的链：${chainNames.join(', ')}`);
    }
    for (const [name, entries] of Object.entries(raw.chains)) {
        if (!Array.isArray(entries)) throw new Error(`dsh-smart-route: 链 "${name}" 不是数组`);
        for (const entry of entries) {
            if (!entry || typeof entry.provider !== 'string' || entry.provider.length === 0) throw new Error(`dsh-smart-route: 链 "${name}" 存在缺少 provider 的渠道`);
            if (typeof entry.model !== 'string' || entry.model.length === 0) throw new Error(`dsh-smart-route: 链 "${name}" 存在缺少 model 的渠道`);
        }
    }
    return { enabled: raw.enabled !== false, defaultChain: raw.defaultChain, chains: raw.chains };
}
