import type { TurnStageProfile, UiDefinition } from '../shared/types';

export type UiLayoutPreset = NonNullable<NonNullable<UiDefinition['layout']>['preset']>;
export type InspectorPosition = NonNullable<NonNullable<UiDefinition['layout']>['inspectorPosition']>;
export type MessageActionId = 'message.copy' | 'message.retry' | 'message.editAndResend' | 'message.inspectRaw';

export const DEFAULT_MESSAGE_ACTIONS: MessageActionId[] = [
  'message.copy',
  'message.retry',
  'message.editAndResend',
  'message.inspectRaw',
];

const layoutPresets: UiLayoutPreset[] = ['chat-only', 'split-inspector', 'chat-with-metrics', 'compact'];
const inspectorPositions: InspectorPosition[] = ['right', 'bottom'];

export interface ResolvedUiLayout {
  preset: UiLayoutPreset;
  inspectorPosition: InspectorPosition;
  inspectorWidth?: number;
  showInspector: boolean;
  initialInspectorTab?: 'Metrics';
  compact: boolean;
}

export function resolveUiLayout(ui?: UiDefinition): ResolvedUiLayout {
  const configuredPreset = ui?.layout?.preset;
  const preset = layoutPresets.includes(configuredPreset as UiLayoutPreset) ? configuredPreset as UiLayoutPreset : 'split-inspector';
  const configuredPosition = ui?.layout?.inspectorPosition;
  const configuredWidth = ui?.layout?.inspectorWidth;
  const inspectorWidth = Number.isFinite(configuredWidth)
    ? Math.min(960, Math.max(240, Math.round(configuredWidth!)))
    : preset === 'compact' ? 320 : undefined;
  return {
    preset,
    inspectorPosition: inspectorPositions.includes(configuredPosition as InspectorPosition) ? configuredPosition as InspectorPosition : 'right',
    inspectorWidth,
    showInspector: preset !== 'chat-only',
    initialInspectorTab: preset === 'chat-with-metrics' ? 'Metrics' : undefined,
    compact: preset === 'compact',
  };
}

export function resolveComposer(ui?: UiDefinition): Required<NonNullable<UiDefinition['composer']>> {
  const enterBehavior = ui?.composer?.enterBehavior;
  const shiftEnterBehavior = ui?.composer?.shiftEnterBehavior;
  return {
    placeholder: typeof ui?.composer?.placeholder === 'string' ? ui.composer.placeholder : '',
    multiline: typeof ui?.composer?.multiline === 'boolean' ? ui.composer.multiline : true,
    enterBehavior: enterBehavior === 'newline' ? 'newline' : 'send',
    shiftEnterBehavior: shiftEnterBehavior === 'send' ? 'send' : 'newline',
    showStopWhileStreaming: typeof ui?.composer?.showStopWhileStreaming === 'boolean' ? ui.composer.showStopWhileStreaming : true,
  };
}

export function resolveMessageActions(profile: TurnStageProfile, role: 'user' | 'assistant' | 'system' | 'tool', canInspect: boolean): MessageActionId[] {
  const configured = profile.ui?.messageActions ?? DEFAULT_MESSAGE_ACTIONS;
  const supported = new Set<MessageActionId>(DEFAULT_MESSAGE_ACTIONS);
  return configured.filter((id, index): id is MessageActionId => supported.has(id as MessageActionId) && configured.indexOf(id) === index).filter((id) => {
    if (id === 'message.retry' || id === 'message.editAndResend') return role === 'assistant';
    if (id === 'message.inspectRaw') return canInspect;
    return true;
  });
}
