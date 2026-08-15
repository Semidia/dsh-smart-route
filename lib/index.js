// dsh-smart-route — Host 半区
//
// 智能路由：注册一个虚拟 provider 路由 `smart-route`，在链上的真实
// provider（deepseek-official / yunzhou / mze 等）之间做自动回退。
//
// 与 polyglot 的关键差异：
//   1. 全错误降级 —— 任何 error finish（含 4xx INVALID_REQUEST、AUTH、
//      HTTP_xxx 等）都尝试切下一家，不再只看限流/5xx。
//   2. 停用开关 —— settings 段 enabled 字段 + RPC setEnabled，可一键停用。
//   3. 模型列表干净 —— 只注册一个虚拟 provider，不注册 configurable
//      providers，模型选择器里不会冒出一堆渠道模型。
//   4. 对话栏按钮 —— client 半区在 composer 工具行提供状态按钮。
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
//       - provider: mze
//         model: deepseek-v4-flash
//   cooldown: { baseMs, maxMs, factor, jitterRatio }
//
// 只依赖 ctx.llm（分派）与 ctx.settings（配置段），不自己实现 HTTP 传输。

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';

export const name = 'dsh-smart-route';
export const inject = ['llm', 'connection'];
const NS = settingsNamespace('smart-route');
const VIRTUAL_PROVIDER = 'smart-route';

const entrySchema = z.object({
    provider: z.string().required(),
    model: z.string().required(),
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
    chains: z.dict(z.array(entrySchema)).required(),
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
        // 只暴露一个聚合模型，不把渠道模型灌进模型选择器。
        return Promise.resolve([{
            provider,
            id: 'auto',
            name: '自动路由',
            inputModalities: ['text'],
        }]);
    }
    resolveModel(provider, model, _signal) {
        const chain = this.#options.chain();
        const first = chain.entries[0];
        if (first === undefined) {
            throw new LlmError('dsh-smart-route: 链上没有配置任何渠道', 'NO_PROVIDER');
        }
        // 转发到第一个渠道做模型能力解析（上下文窗口等）。
        const resolved = this.#options.resolveModelInfo(first.provider, first.model);
        if (resolved === undefined) {
            return Promise.resolve({
                provider,
                id: model,
                name: model,
                inputModalities: ['text'],
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
            if (this.#cooldown.cooling(entry.provider)) {
                this.#options.logger?.info(`dsh-smart-route: ${entry.provider} 冷却中 — 跳过`);
                continue;
            }
            const outcome = yield* this.#tryEntry(options, entry, attempt);
            if (outcome.kind === 'served') {
                this.#cooldown.recordSuccess(entry.provider);
                if (outcome.usage) yield { type: 'usage', usage: outcome.usage };
                yield { type: 'finish', reason: outcome.finish };
                return;
            }
            if (outcome.terminal) {
                // 内容已流出或调用方取消：无法回退，直接结束。
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
        try {
            const stream = this.#options.dispatch({
                ...options,
                provider: entry.provider,
                model: entry.model,
            });
            for await (const chunk of stream) {
                if (chunk.type === 'usage') {
                    usage = chunk.usage;
                    continue;
                }
                if (chunk.type === 'finish') {
                    const finish = chunk.reason;
                    const ok = finish.kind !== 'error' && finish.kind !== 'aborted';
                    if (ok) {
                        return { kind: 'served', finish, usage };
                    }
                    if (finish.kind === 'aborted') {
                        // 调用方取消：不切换渠道，直接终止。
                        return { kind: 'failed', terminal: true, finish, usage };
                    }
                    // 任何 error（含 4xx / INVALID_REQUEST / AUTH / HTTP_xxx）都可回退。
                    const failure = finish.failure;
                    this.#cooldown.recordFailure(entry.provider);
                    this.#options.logger?.info(`dsh-smart-route: ${entry.provider} 失败(${failure?.code ?? '?'}: ${failure?.message ?? ''}) — 尝试下一家`);
                    return { kind: 'failed', terminal: false, finish, usage };
                }
                forwardedContent = true;
                yield chunk;
            }
            // 流正常耗尽但没有 finish：视为成功。
            return { kind: 'served', finish: { kind: 'stop' }, usage };
        }
        catch (error) {
            const failure = error instanceof LlmError
                ? { message: error.message, code: error.code }
                : { message: error && error.message ? error.message : String(error), code: 'TRANSPORT' };
            if (forwardedContent) {
                // 内容已流出后的传输错误：无法回退。
                this.#options.logger?.info(`dsh-smart-route: ${entry.provider} 已流式输出后出错 — 不回退`);
                return { kind: 'failed', terminal: true, finish: { kind: 'error', failure }, usage };
            }
            this.#cooldown.recordFailure(entry.provider);
            this.#options.logger?.info(`dsh-smart-route: ${entry.provider} 请求失败(${failure.code}: ${failure.message}) — 尝试下一家`);
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

    const chainNamesOf = () => Object.keys(current().chains ?? {});
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
        try {
            return ctx.llm.resolveModelInfo(provider, model);
        }
        catch {
            return undefined;
        }
    };

    const router = new SmartRouteAdapter({
        state: () => state(),
        chain: () => chainEntries(current().defaultChain),
        dispatch: (options) => ctx.llm.stream(options),
        cooldown: cooldownConfig,
        resolveModelInfo,
        defaultContextWindow: () => 1000000,
        defaultMaxTokens: () => 256000,
        logger: ctx.logger,
    });
    ctx.llm.registerAdapter([VIRTUAL_PROVIDER], router);

    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => { current = source; },
        onChange: () => { state(); },
    });

    // ── loopback RPC：对话栏按钮 / 设置卡调用 ──────────────────────────
    ctx.connection.rpc.handle('/dsh-smart-route', async (endpoint, payload) => {
        if (endpoint === 'status') {
            const s = state();
            const chain = chainEntries(s.defaultChain);
            return {
                ok: true,
                value: {
                    enabled: s.enabled,
                    defaultChain: chain.name,
                    chains: s.chains,
                    cooldown: router.cooldown.status(Date.now()),
                    providers: ctx.llm.listProviders().map((p) => p.id),
                    virtualProvider: VIRTUAL_PROVIDER,
                },
            };
        }
        if (endpoint === 'setEnabled') {
            const enabled = payload && typeof payload.enabled === 'boolean' ? payload.enabled : !state().enabled;
            const scope = ctx.get('settings');
            if (scope === undefined) return { ok: false, error: { code: 'no-settings', message: 'settings 服务不可用' } };
            try {
                const currentSection = scope.get(NS) ?? {};
                await scope.update(NS, { ...(typeof currentSection === 'object' && currentSection !== null ? currentSection : {}), enabled });
                return { ok: true, value: { enabled } };
            }
            catch (error) {
                return { ok: false, error: { code: 'write-failed', message: error && error.message ? error.message : String(error) } };
            }
        }
        if (endpoint === 'setChain') {
            const s = state();
            const scope = ctx.get('settings');
            if (scope === undefined) return { ok: false, error: { code: 'no-settings', message: 'settings 服务不可用' } };
            const name = payload && typeof payload.name === 'string' ? payload.name : null;
            const entries = payload && Array.isArray(payload.entries) ? payload.entries : null;
            try {
                const currentSection = scope.get(NS) ?? {};
                const base = typeof currentSection === 'object' && currentSection !== null ? currentSection : {};
                const chains = { ...(base.chains ?? s.chains) };
                if (name && entries) chains[name] = entries.map((e) => ({ provider: String(e.provider), model: String(e.model) }));
                const next = { ...base, chains };
                if (name) next.defaultChain = name;
                await scope.replace(next);
                return { ok: true, value: { chains: next.chains, defaultChain: next.defaultChain } };
            }
            catch (error) {
                return { ok: false, error: { code: 'write-failed', message: error && error.message ? error.message : String(error) } };
            }
        }
        if (endpoint === 'setCooldown') {
            const scope = ctx.get('settings');
            if (scope === undefined) return { ok: false, error: { code: 'no-settings', message: 'settings 服务不可用' } };
            const patch = {};
            if (payload && typeof payload.baseMs === 'number') patch.baseMs = payload.baseMs;
            if (payload && typeof payload.maxMs === 'number') patch.maxMs = payload.maxMs;
            if (payload && typeof payload.factor === 'number') patch.factor = payload.factor;
            if (payload && typeof payload.jitterRatio === 'number') patch.jitterRatio = payload.jitterRatio;
            try {
                const currentSection = scope.get(NS) ?? {};
                const base = typeof currentSection === 'object' && currentSection !== null ? currentSection : {};
                await scope.update(NS, { ...base, cooldown: { ...(base.cooldown ?? {}), ...patch } });
                return { ok: true, value: { cooldown: { ...(base.cooldown ?? {}), ...patch } } };
            }
            catch (error) {
                return { ok: false, error: { code: 'write-failed', message: error && error.message ? error.message : String(error) } };
            }
        }
        return { ok: false, error: { code: 'bad-request', message: 'unknown endpoint ' + JSON.stringify(endpoint) } };
    }, { authority: 'loopback' });
}

/** Resolve raw config into a normalized state (schema already applied). */
function resolveState(raw) {
    const chainNames = Object.keys(raw.chains ?? {});
    if (chainNames.length === 0) throw new Error('dsh-smart-route: 至少需要一条链');
    if (!(raw.defaultChain in raw.chains)) {
        throw new Error(`dsh-smart-route: defaultChain "${raw.defaultChain}" 不是已配置的链：${chainNames.join(', ')}`);
    }
    for (const [name, entries] of Object.entries(raw.chains)) {
        if (!Array.isArray(entries) || entries.length === 0) throw new Error(`dsh-smart-route: 链 "${name}" 为空`);
        for (const entry of entries) {
            if (!entry || typeof entry.provider !== 'string' || entry.provider.length === 0) throw new Error(`dsh-smart-route: 链 "${name}" 存在缺少 provider 的渠道`);
            if (typeof entry.model !== 'string' || entry.model.length === 0) throw new Error(`dsh-smart-route: 链 "${name}" 存在缺少 model 的渠道`);
        }
    }
    return { enabled: raw.enabled !== false, defaultChain: raw.defaultChain, chains: raw.chains };
}
