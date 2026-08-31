import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscodeTypes from 'vscode';

const mock = vi.hoisted(() => ({
  createChatParticipant: vi.fn(),
  invokeTool: vi.fn(),
  tools: [] as Array<{ name: string; description: string; inputSchema: object; tags: string[] }>,
  Uri: class Uri {
    constructor(readonly value: string) {}
    static joinPath(base: { value: string }, ...parts: string[]) { return new this(`${base.value}/${parts.join('/')}`); }
    toString() { return this.value; }
  },
  LanguageModelTextPart: class LanguageModelTextPart { constructor(readonly value: string) {} },
  LanguageModelToolCallPart: class LanguageModelToolCallPart { constructor(readonly callId: string, readonly name: string, readonly input: object) {} },
  LanguageModelToolResultPart: class LanguageModelToolResultPart { constructor(readonly callId: string, readonly content: unknown[]) {} },
  LanguageModelError: class LanguageModelError extends Error { constructor(readonly code: string) { super(code); } },
}));

vi.mock('vscode', () => ({
  Uri: mock.Uri,
  chat: { createChatParticipant: mock.createChatParticipant },
  lm: {
    get tools() { return mock.tools; },
    invokeTool: mock.invokeTool,
  },
  l10n: {
    t: (message: string, values?: Record<string, unknown>) => Object.entries(values ?? {}).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), message),
  },
  LanguageModelChatMessage: class LanguageModelChatMessage {
    static User(content: string | unknown[]) { return { role: 'user', content: typeof content === 'string' ? [new mock.LanguageModelTextPart(content)] : content }; }
    static Assistant(content: string | unknown[]) { return { role: 'assistant', content: typeof content === 'string' ? [new mock.LanguageModelTextPart(content)] : content }; }
  },
  LanguageModelTextPart: mock.LanguageModelTextPart,
  LanguageModelToolCallPart: mock.LanguageModelToolCallPart,
  LanguageModelToolResultPart: mock.LanguageModelToolResultPart,
  LanguageModelToolResult: class LanguageModelToolResult { constructor(readonly content: unknown[]) {} },
  LanguageModelError: mock.LanguageModelError,
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
}));

import {
  TURNSTAGE_CHAT_COMMANDS,
  TURNSTAGE_CHAT_PARTICIPANT_ID,
  buildTurnStageFollowups,
  createTurnStageChatRequestHandler,
  registerTurnStageChatParticipant,
  type TurnStageChatMetadataV1,
} from '../src/extension/copilot/chatParticipant';
import { COPILOT_TOOL_NAMES } from '../src/extension/copilot/types';

const { Uri, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelError } = mock;

interface ResponseRecorder {
  markdown: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
  reference: ReturnType<typeof vi.fn>;
  button: ReturnType<typeof vi.fn>;
}

function response(): ResponseRecorder {
  return { markdown: vi.fn(), progress: vi.fn(), reference: vi.fn(), button: vi.fn() };
}

function stream(parts: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { for (const part of parts) yield part; } };
}

function model(responses: unknown[][] | Error[]) {
  let index = 0;
  return {
    id: 'copilot-test', name: 'Test Copilot', vendor: 'copilot', family: 'test', version: '1', maxInputTokens: 16_000,
    countTokens: vi.fn(async (value: string) => value.length),
    sendRequest: vi.fn(async () => {
      const next = responses[index++] ?? [];
      if (next instanceof Error) throw next;
      return { stream: stream(next), text: stream([]) };
    }),
  };
}

function request(selectedModel: ReturnType<typeof model>, overrides: Record<string, unknown> = {}) {
  return {
    prompt: '請分析 run-1 為什麼 TTFT 很慢',
    command: 'diagnose',
    references: [],
    toolReferences: [],
    toolInvocationToken: {} as never,
    model: selectedModel,
    ...overrides,
  } as unknown as vscodeTypes.ChatRequest;
}

function context(metadata?: TurnStageChatMetadataV1): vscodeTypes.ChatContext {
  return { history: metadata ? [{ result: { metadata } }] : [] } as unknown as vscodeTypes.ChatContext;
}

function token(cancelled = false): vscodeTypes.CancellationToken {
  return { isCancellationRequested: cancelled } as vscodeTypes.CancellationToken;
}

function metadata(result: vscodeTypes.ChatResult | void | null): TurnStageChatMetadataV1 {
  return result?.metadata as unknown as TurnStageChatMetadataV1;
}

beforeEach(() => {
  mock.createChatParticipant.mockReset();
  mock.invokeTool.mockReset();
  mock.tools = Object.values(COPILOT_TOOL_NAMES).map((name) => ({ name, description: name, inputSchema: {}, tags: ['turnstage'] }));
});

describe('@turnstage chat participant', () => {
  it('declares one sticky participant with five localized slash commands', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { activationEvents: string[]; contributes: { chatParticipants: Array<{ id: string; name: string; isSticky: boolean; commands: Array<{ name: string }> }> } };
    expect(manifest.activationEvents).toContain('onChatParticipant:turnstage.chat');
    expect(manifest.contributes.chatParticipants).toEqual([expect.objectContaining({ id: TURNSTAGE_CHAT_PARTICIPANT_ID, name: 'turnstage', isSticky: true })]);
    expect(manifest.contributes.chatParticipants[0]?.commands.map((command) => command.name)).toEqual(TURNSTAGE_CHAT_COMMANDS);
    const english = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const chinese = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.zh-tw.json'), 'utf8')) as Record<string, string>;
    for (const key of ['chatParticipant.description', ...TURNSTAGE_CHAT_COMMANDS.map((command) => `chatParticipant.command.${command}`)]) {
      expect(english[key]).toBeTruthy();
      expect(chinese[key]).toBeTruthy();
    }
  });

  it('registers the participant icon and derives bounded follow-ups from safe metadata', () => {
    const participant = { id: TURNSTAGE_CHAT_PARTICIPANT_ID, dispose: vi.fn(), requestHandler: vi.fn(), onDidReceiveFeedback: vi.fn() } as unknown as vscodeTypes.ChatParticipant;
    mock.createChatParticipant.mockReturnValue(participant);
    const registered = registerTurnStageChatParticipant({ extensionUri: new Uri('extension:/turnstage') } as unknown as vscodeTypes.ExtensionContext);
    expect(registered).toBe(participant);
    expect(mock.createChatParticipant).toHaveBeenCalledWith(TURNSTAGE_CHAT_PARTICIPANT_ID, expect.any(Function));
    expect(String((participant.iconPath as unknown as { value: string }).value)).toContain('media/icon.png');
    const followups = buildTurnStageFollowups({ version: 1, command: 'diagnose', status: 'partial', toolNames: [], runId: 'run-1', evidenceIds: ['evidence-1'], failureIds: ['failure-1'], caseIds: [] });
    expect(followups).toHaveLength(3);
    expect(followups.every((item) => item.participant === TURNSTAGE_CHAT_PARTICIPANT_ID)).toBe(true);
    expect(JSON.stringify(followups)).not.toContain('undefined');
  });

  it('forwards a Chinese request and exposes only command-scoped TurnStage tools', async () => {
    const selectedModel = model([[new LanguageModelTextPart('TTFT 的確定性證據如下。')]]);
    const recorder = response();
    const handler = createTurnStageChatRequestHandler();
    const result = await handler(request(selectedModel), context(), recorder as unknown as vscodeTypes.ChatResponseStream, token());
    const firstCall = selectedModel.sendRequest.mock.calls[0] as unknown as [Array<{ content: Array<{ value?: string }> }>, { tools?: Array<{ name: string }> }];
    expect(firstCall?.[0]?.[1]?.content?.[0]?.value).toContain('請分析 run-1');
    expect(firstCall?.[1]?.tools?.map((tool: { name: string }) => tool.name)).toEqual([
      COPILOT_TOOL_NAMES.inspectFailure,
      COPILOT_TOOL_NAMES.validateTests,
      COPILOT_TOOL_NAMES.analyzeRun,
    ]);
    expect(recorder.markdown).toHaveBeenCalledWith('TTFT 的確定性證據如下。');
    expect(metadata(result).status).toBe('complete');
  });

  it('invokes a tool with the chat token, renders native evidence actions, and returns safe state', async () => {
    const call = new LanguageModelToolCallPart('call-1', COPILOT_TOOL_NAMES.analyzeRun, { runId: 'run-1', mode: 'performance' });
    const selectedModel = model([[call], [new LanguageModelTextPart('The observed TTFT is slower than the bounded baseline.')]]);
    mock.invokeTool.mockResolvedValue({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { runId: 'run-1', outcome: 'failed', capsule: { evidenceId: 'evidence-1', profileId: 'profile-1' } }, secret: 'ghp_NEVER_STORE_THIS' }))] });
    const recorder = response();
    const toolToken = { opaque: true };
    const result = await createTurnStageChatRequestHandler()(request(selectedModel, { toolInvocationToken: toolToken }), context(), recorder as unknown as vscodeTypes.ChatResponseStream, token());
    expect(mock.invokeTool).toHaveBeenCalledWith(COPILOT_TOOL_NAMES.analyzeRun, expect.objectContaining({ input: { runId: 'run-1', mode: 'performance' }, toolInvocationToken: toolToken, tokenizationOptions: expect.any(Object) }), expect.anything());
    expect(recorder.button).toHaveBeenCalledWith(expect.objectContaining({ command: 'turnstage.openTestEvidence', arguments: [{ evidenceId: 'evidence-1' }] }));
    expect(recorder.button).toHaveBeenCalledWith(expect.objectContaining({ command: 'workbench.view.testing.focus' }));
    const safe = metadata(result);
    expect(safe).toMatchObject({ status: 'complete', runId: 'run-1', profileId: 'profile-1', evidenceIds: ['evidence-1'], outcome: 'failed' });
    expect(JSON.stringify(safe)).not.toContain('ghp_NEVER_STORE_THIS');
  });

  it('returns parallel tool results as separate user messages in call order', async () => {
    const calls = [
      new LanguageModelToolCallPart('call-1', COPILOT_TOOL_NAMES.analyzeRun, { profile: 'profile-1', mode: 'configuration' }),
      new LanguageModelToolCallPart('call-2', COPILOT_TOOL_NAMES.validateTests, { profileId: 'profile-1' }),
    ];
    const selectedModel = model([calls, [new LanguageModelTextPart('設定驗證已完成。')]]);
    mock.invokeTool
      .mockResolvedValueOnce({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { profileId: 'profile-1', status: 'complete' } }))] })
      .mockResolvedValueOnce({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { valid: true, total: 1 } }))] });

    await createTurnStageChatRequestHandler()(request(selectedModel, { command: 'configure' }), context(), response() as unknown as vscodeTypes.ChatResponseStream, token());

    const secondMessages = (selectedModel.sendRequest.mock.calls[1] as unknown as [Array<{ content: unknown[] }>])?.[0];
    expect(secondMessages.at(-3)?.content).toHaveLength(1);
    expect(secondMessages.at(-2)?.content).toHaveLength(1);
    expect(secondMessages.at(-3)?.content[0]).toBeInstanceOf(LanguageModelToolResultPart);
    expect(secondMessages.at(-2)?.content[0]).toBeInstanceOf(LanguageModelToolResultPart);
    expect(secondMessages.at(-1)?.content[0]).toBeInstanceOf(LanguageModelTextPart);
    expect((secondMessages.at(-1)?.content[0] as { value?: string }).value).toContain('Continue the original request');
  });

  it('never executes the same side-effecting tool twice in one request', async () => {
    const calls = [
      new LanguageModelToolCallPart('call-1', COPILOT_TOOL_NAMES.runTests, { selectors: ['case-1'] }),
      new LanguageModelToolCallPart('call-2', COPILOT_TOOL_NAMES.runTests, { selectors: ['case-1'] }),
    ];
    const selectedModel = model([calls, [new LanguageModelTextPart('One confirmed run completed.')]]);
    mock.invokeTool.mockResolvedValue({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { runId: 'run-1', outcome: 'passed' } }))] });
    const result = await createTurnStageChatRequestHandler()(request(selectedModel, { command: 'run' }), context(), response() as unknown as vscodeTypes.ChatResponseStream, token());
    expect(mock.invokeTool).toHaveBeenCalledTimes(1);
    expect(metadata(result)).toMatchObject({ status: 'partial', failureCode: 'DUPLICATE_SIDE_EFFECT' });
  });

  it('allows one disclosed quality review and one recorded advisory result in sequence', async () => {
    const disclose = new LanguageModelToolCallPart('call-1', COPILOT_TOOL_NAMES.reviewResponseQuality, { action: 'disclose', evidenceIds: ['evidence-1'] });
    const record = new LanguageModelToolCallPart('call-2', COPILOT_TOOL_NAMES.reviewResponseQuality, { action: 'record', grantId: 'grant-1', review: { summary: 'Bounded review', findings: [] } });
    const selectedModel = model([[disclose], [record], [new LanguageModelTextPart('The advisory review is complete and did not change the formal outcome.')]]);
    mock.invokeTool
      .mockResolvedValueOnce({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { action: 'disclose', grant: { grantId: 'grant-1', evidenceIds: ['evidence-1'] } } }))] })
      .mockResolvedValueOnce({ content: [new LanguageModelTextPart(JSON.stringify({ ok: true, data: { action: 'record', advisoryOnly: true } }))] });
    const result = await createTurnStageChatRequestHandler()(request(selectedModel, { command: 'evidence' }), context(), response() as unknown as vscodeTypes.ChatResponseStream, token());
    expect(mock.invokeTool).toHaveBeenCalledTimes(2);
    expect(metadata(result)).toMatchObject({ status: 'complete', evidenceIds: ['evidence-1'] });
  });

  it('fails closed for oversized prompts, cancellation, and model permission or quota errors', async () => {
    const oversizedModel = model([]);
    const oversized = await createTurnStageChatRequestHandler()(request(oversizedModel, { prompt: 'x'.repeat(8_001) }), context(), response() as unknown as vscodeTypes.ChatResponseStream, token());
    expect(oversizedModel.sendRequest).not.toHaveBeenCalled();
    expect(metadata(oversized)).toMatchObject({ status: 'failed', failureCode: 'PROMPT_TOO_LARGE' });

    const cancelledModel = model([]);
    const cancelled = await createTurnStageChatRequestHandler()(request(cancelledModel), context(), response() as unknown as vscodeTypes.ChatResponseStream, token(true));
    expect(cancelledModel.sendRequest).not.toHaveBeenCalled();
    expect(metadata(cancelled).status).toBe('cancelled');

    for (const code of ['NoPermissions', 'Blocked', 'NotFound']) {
      const failedModel = model([new LanguageModelError(code)]);
      const recorder = response();
      const failed = await createTurnStageChatRequestHandler()(request(failedModel), context(), recorder as unknown as vscodeTypes.ChatResponseStream, token());
      expect(metadata(failed)).toMatchObject({ status: 'failed', failureCode: code });
      expect(recorder.markdown.mock.calls.flat().join(' ')).toMatch(/access|quota|available|model/i);
    }
  });

  it('uses attached tools in required mode and never offers non-TurnStage tools', async () => {
    mock.tools.push({ name: 'external_shell', description: 'unsafe', inputSchema: {}, tags: [] });
    const selectedModel = model([[new LanguageModelTextPart('Done.')]]);
    await createTurnStageChatRequestHandler()(request(selectedModel, { toolReferences: [{ name: COPILOT_TOOL_NAMES.analyzeRun }] }), context(), response() as unknown as vscodeTypes.ChatResponseStream, token());
    const options = (selectedModel.sendRequest.mock.calls[0] as unknown as [unknown, { toolMode?: number; tools: Array<{ name: string }> }])?.[1];
    expect(options?.toolMode).toBe(2);
    expect(options?.tools.map((tool) => tool.name)).toEqual([COPILOT_TOOL_NAMES.analyzeRun]);
    expect(options?.tools.some((tool: { name: string }) => tool.name === 'external_shell')).toBe(false);
  });
});
