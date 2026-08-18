/**
 * SuoCode request interception extension for chrome-devtools-mcp.
 *
 * This file is copied into chrome-devtools-mcp/build/src/tools by the
 * version-locked postinstall patch. Keep imports relative to that destination.
 */
import { zod } from '../third_party/index.js';
import { ToolCategory } from './categories.js';
import { definePageTool } from './ToolDefinition.js';

const RESOURCE_TYPES = [
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'texttrack',
    'xhr',
    'fetch',
    'prefetch',
    'eventsource',
    'websocket',
    'manifest',
    'signedexchange',
    'ping',
    'cspviolationreport',
    'preflight',
    'fedcm',
    'other',
];

const ABORT_REASONS = [
    'aborted',
    'accessdenied',
    'addressunreachable',
    'blockedbyclient',
    'blockedbyresponse',
    'connectionaborted',
    'connectionclosed',
    'connectionfailed',
    'connectionrefused',
    'connectionreset',
    'internetdisconnected',
    'namenotresolved',
    'timedout',
    'failed',
];

const interceptionStates = new WeakMap();
let nextRuleId = 1;

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function compileUrlPattern(pattern) {
    const source = pattern
        .split('*')
        .map(escapeRegExp)
        .join('.*');
    return new RegExp(`^${source}$`);
}

function serializeRule(rule) {
    return {
        ruleId: rule.id,
        urlPattern: rule.urlPattern,
        requestMethod: rule.requestMethod,
        resourceTypes: rule.resourceTypes,
        behavior: rule.behavior,
        response: rule.response,
        errorReason: rule.errorReason,
        requestOverrides: rule.requestOverrides,
        remainingMatches: rule.remainingMatches ?? null,
        matchCount: rule.matchCount,
    };
}

function requestMatches(rule, request) {
    if (!rule.urlRegex.test(request.url())) return false;
    if (rule.requestMethod && request.method().toUpperCase() !== rule.requestMethod) return false;
    if (rule.resourceTypes?.length && !rule.resourceTypes.includes(request.resourceType())) return false;
    return true;
}

function requestWasHandled(request) {
    return request.isInterceptResolutionHandled?.() === true;
}

async function continueRequest(request, requestOverrides) {
    if (requestWasHandled(request)) return;
    if (!requestOverrides) {
        await request.continue();
        return;
    }
    const overrides = {};
    if (requestOverrides.url !== undefined) overrides.url = requestOverrides.url;
    if (requestOverrides.method !== undefined) overrides.method = requestOverrides.method;
    if (requestOverrides.postData !== undefined) overrides.postData = requestOverrides.postData;
    if (requestOverrides.headers !== undefined) {
        overrides.headers = { ...request.headers(), ...requestOverrides.headers };
    }
    await request.continue(overrides);
}

async function applyRule(rule, request) {
    if (rule.behavior === 'block') {
        await request.abort(rule.errorReason ?? 'failed');
        return;
    }
    if (rule.behavior === 'continue') {
        await continueRequest(request, rule.requestOverrides);
        return;
    }
    const mock = rule.response ?? {};
    const body = mock.bodyBase64 === undefined
        ? mock.body
        : Buffer.from(mock.bodyBase64, 'base64');
    await request.respond({
        status: mock.status ?? 200,
        headers: mock.headers,
        contentType: mock.contentType,
        body,
    });
}

async function dispatchRequest(state, request) {
    const rule = state.rules.find(candidate => requestMatches(candidate, request));
    if (!rule) {
        await continueRequest(request);
        return;
    }
    rule.matchCount += 1;
    if (rule.remainingMatches !== undefined) {
        rule.remainingMatches -= 1;
        if (rule.remainingMatches === 0) {
            state.rules = state.rules.filter(candidate => candidate !== rule);
        }
    }
    try {
        await applyRule(rule, request);
    }
    catch (error) {
        try {
            await continueRequest(request);
        }
        catch {
            // Preserve the original interception failure below.
        }
        throw error;
    }
    if (state.rules.length === 0) {
        void deactivateState(state).catch(error => {
            console.error('[suocode-browser] Failed to disable empty request interception state:', error);
        });
    }
}

function createState(page) {
    const state = {
        page,
        rules: [],
        enabled: false,
        disablePromise: undefined,
        requestListener: undefined,
        closeListener: undefined,
    };
    state.requestListener = request => {
        void dispatchRequest(state, request).catch(error => {
            console.error(`[suocode-browser] Request interception failed for ${request.url()}:`, error);
        });
    };
    state.closeListener = () => {
        interceptionStates.delete(page);
        state.enabled = false;
    };
    return state;
}

async function activateState(page) {
    let state = interceptionStates.get(page);
    if (state?.disablePromise) {
        await state.disablePromise;
        state = interceptionStates.get(page);
    }
    if (state?.enabled) return state;
    state ??= createState(page);
    interceptionStates.set(page, state);
    page.on('request', state.requestListener);
    page.once('close', state.closeListener);
    try {
        await page.setRequestInterception(true);
        state.enabled = true;
        return state;
    }
    catch (error) {
        page.off('request', state.requestListener);
        page.off('close', state.closeListener);
        interceptionStates.delete(page);
        throw new Error(`NETWORK_INTERCEPTION_ENABLE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}

async function deactivateState(state) {
    if (state.disablePromise) return state.disablePromise;
    state.disablePromise = (async () => {
        try {
            await state.page.setRequestInterception(false);
        }
        catch (error) {
            throw new Error(`NETWORK_INTERCEPTION_DISABLE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        state.page.off('request', state.requestListener);
        state.page.off('close', state.closeListener);
        state.enabled = false;
        if (interceptionStates.get(state.page) === state) interceptionStates.delete(state.page);
    })();
    try {
        await state.disablePromise;
    }
    finally {
        state.disablePromise = undefined;
    }
}

function requireAddParameters(params) {
    if (!params.urlPattern?.trim()) {
        throw new Error('INTERCEPTION_PATTERN_REQUIRED: operation=add requires a non-empty urlPattern.');
    }
    if (!params.behavior) {
        throw new Error('INTERCEPTION_BEHAVIOR_REQUIRED: operation=add requires mock, block, or continue.');
    }
    if (params.requestMethod !== undefined && !params.requestMethod.trim()) {
        throw new Error('INTERCEPTION_METHOD_INVALID: requestMethod cannot be empty.');
    }
    if (params.behavior !== 'mock' && params.response !== undefined) {
        throw new Error('INTERCEPTION_RESPONSE_INVALID: response is only valid for behavior=mock.');
    }
    if (params.behavior !== 'continue' && params.requestOverrides !== undefined) {
        throw new Error('INTERCEPTION_OVERRIDES_INVALID: requestOverrides is only valid for behavior=continue.');
    }
    if (params.behavior !== 'block' && params.errorReason !== undefined) {
        throw new Error('INTERCEPTION_ABORT_REASON_INVALID: errorReason is only valid for behavior=block.');
    }
    if (params.response?.body !== undefined && params.response?.bodyBase64 !== undefined) {
        throw new Error('INTERCEPTION_BODY_INVALID: set either response.body or response.bodyBase64, not both.');
    }
}

const headersSchema = zod
    .record(zod.string(), zod.string())
    .describe('HTTP headers as a JSON object whose values are strings.');

const mockResponseSchema = zod.object({
    status: zod.number().int().min(100).max(599).optional().describe('HTTP status code. Defaults to 200.'),
    headers: headersSchema.optional(),
    contentType: zod.string().optional().describe('Response Content-Type, for example application/json.'),
    body: zod.string().optional().describe('UTF-8 response body.'),
    bodyBase64: zod.string().optional().describe('Base64-encoded binary response body. Mutually exclusive with body.'),
}).strict();

const requestOverridesSchema = zod.object({
    url: zod.string().optional().describe('Replacement request URL.'),
    method: zod.string().optional().describe('Replacement HTTP method.'),
    headers: headersSchema.optional().describe('Headers to merge into the original request headers.'),
    postData: zod.string().optional().describe('Replacement request body.'),
}).strict();

export const interceptNetworkRequest = definePageTool({
    name: 'intercept_network_request',
    description: `Adds, lists, removes, or clears request interception rules on the selected page. Rules persist across navigations and can mock a response, block a request, or continue it with request overrides. The newest matching rule wins.`,
    annotations: {
        category: ToolCategory.NETWORK,
        readOnlyHint: false,
    },
    schema: {
        operation: zod
            .enum(['add', 'list', 'remove', 'clear'])
            .describe('Rule operation to perform.'),
        ruleId: zod
            .string()
            .optional()
            .describe('Rule ID returned by add. Required for remove.'),
        urlPattern: zod
            .string()
            .optional()
            .describe('Full-URL glob pattern for add. * matches any number of characters, for example *://*/api/users*.'),
        requestMethod: zod
            .string()
            .optional()
            .describe('Optional case-insensitive HTTP method filter, for example GET or POST.'),
        resourceTypes: zod
            .array(zod.enum(RESOURCE_TYPES))
            .optional()
            .describe('Optional resource type filters. Omit to match every type.'),
        behavior: zod
            .enum(['mock', 'block', 'continue'])
            .optional()
            .describe('Matched-request behavior. Required for add.'),
        response: mockResponseSchema
            .optional()
            .describe('Mock response settings for behavior=mock. Defaults to an empty 200 response.'),
        errorReason: zod
            .enum(ABORT_REASONS)
            .optional()
            .describe('Puppeteer abort reason for behavior=block. Defaults to failed.'),
        requestOverrides: requestOverridesSchema
            .optional()
            .describe('Request changes for behavior=continue. Headers are merged with original headers.'),
        times: zod
            .number()
            .int()
            .positive()
            .optional()
            .describe('Automatically remove the rule after this many matches. Omit for unlimited matches.'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response) => {
        const page = request.page.pptrPage;
        const params = request.params;
        if (params.operation === 'list') {
            const state = interceptionStates.get(page);
            response.appendResponseLine(JSON.stringify({
                interceptionEnabled: state?.enabled ?? false,
                rules: state?.rules.map(serializeRule) ?? [],
            }, null, 2));
            return;
        }
        if (params.operation === 'clear') {
            const state = interceptionStates.get(page);
            const removedRuleCount = state?.rules.length ?? 0;
            if (state) {
                state.rules = [];
                await deactivateState(state);
            }
            response.appendResponseLine(`Cleared ${removedRuleCount} request interception rule(s).`);
            return;
        }
        if (params.operation === 'remove') {
            if (!params.ruleId?.trim()) {
                throw new Error('INTERCEPTION_RULE_ID_REQUIRED: operation=remove requires ruleId.');
            }
            const state = interceptionStates.get(page);
            const index = state?.rules.findIndex(rule => rule.id === params.ruleId) ?? -1;
            if (!state || index < 0) {
                throw new Error(`INTERCEPTION_RULE_NOT_FOUND: No rule named ${params.ruleId} exists on the selected page.`);
            }
            state.rules.splice(index, 1);
            if (state.rules.length === 0) await deactivateState(state);
            response.appendResponseLine(`Removed request interception rule ${params.ruleId}.`);
            return;
        }
        requireAddParameters(params);
        const state = await activateState(page);
        const rule = {
            id: `intercept-${nextRuleId++}`,
            urlPattern: params.urlPattern.trim(),
            urlRegex: compileUrlPattern(params.urlPattern.trim()),
            requestMethod: params.requestMethod?.trim().toUpperCase(),
            resourceTypes: params.resourceTypes?.length ? [...params.resourceTypes] : undefined,
            behavior: params.behavior,
            response: params.response,
            errorReason: params.errorReason,
            requestOverrides: params.requestOverrides,
            remainingMatches: params.times,
            matchCount: 0,
        };
        state.rules.unshift(rule);
        response.appendResponseLine(`Added request interception rule ${rule.id}.`);
        response.appendResponseLine(JSON.stringify(serializeRule(rule), null, 2));
    },
});
