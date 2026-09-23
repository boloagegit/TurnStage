import { findNodeAtLocation, type Node } from 'jsonc-parser';
import type { TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { webNeedsPerformanceBaseline } from '../../src/shared/webTestCapabilities';
import { validateProfile, type SchemaValidationError } from './generated/profileSchemaValidator.mjs';

export interface ProfileSourceDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  offset: number;
  length: number;
  path: Array<string | number>;
  supportedHosts?: Array<'web' | 'vscode' | 'cli'>;
}

type DiagnosticLocale = 'en' | 'zh-TW' | 'ja' | 'ko';

export function schemaDiagnostics(profile: TurnStageProfile, tree?: Node, locale: string = 'en'): ProfileSourceDiagnostic[] {
  if (validateProfile(profile)) return [];
  return (validateProfile.errors ?? []).map((error) => schemaIssue(error, tree, normalizedLocale(locale)));
}

export function webCompatibilityDiagnostics(profile: TurnStageProfile, tree: Node | undefined, environments: readonly TurnStageEnvironment[], locale: string = 'en'): ProfileSourceDiagnostic[] {
  const messages = compatibilityMessages[normalizedLocale(locale)];
  const issues: ProfileSourceDiagnostic[] = [];
  const add = (code: string, path: Array<string | number>, message: string, supportedHosts: Array<'web' | 'vscode' | 'cli'> = ['vscode', 'cli']) => {
    const node = tree ? findNodeAtLocation(tree, path) : undefined;
    issues.push({ code, severity: 'warning', message, offset: node?.offset ?? 0, length: node?.length ?? 1, path, supportedHosts });
  };
  if (!profile.environment && environments.length > 1) add('environment.implicit', ['environment'], messages.environment, ['web', 'vscode', 'cli']);
  for (const [index, scenario] of (profile.tests?.scenarios ?? []).entries()) {
    if (scenario.faults) add('web.unsupported.faults', ['tests', 'scenarios', index, 'faults'], messages.faults);
    if (scenario.comparison) add('web.unsupported.comparison', ['tests', 'scenarios', index, 'comparison'], messages.comparison);
    if (webNeedsPerformanceBaseline(scenario)) add('web.unsupported.performance', ['tests', 'scenarios', index, 'performance'], messages.performance);
  }
  if (profile.tests?.reporting?.outputDirectory) add('web.ignored.reportingOutputDirectory', ['tests', 'reporting', 'outputDirectory'], messages.outputDirectory, ['vscode', 'cli']);
  if (profile.tests?.visual?.baselineDirectory) add('web.ignored.visualBaselineDirectory', ['tests', 'visual', 'baselineDirectory'], messages.baselineDirectory, ['vscode', 'cli']);
  return issues;
}

function schemaIssue(error: SchemaValidationError, tree: Node | undefined, locale: DiagnosticLocale): ProfileSourceDiagnostic {
  const path = pointerPath(error.instancePath);
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') path.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') path.push(error.params.additionalProperty);
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  return {
    code: `schema.${error.keyword}`,
    severity: 'error',
    message: schemaMessage(error, path, locale),
    offset: node?.offset ?? 0,
    length: node?.length ?? 1,
    path,
  };
}

function pointerPath(pointer: string): Array<string | number> {
  if (!pointer) return [];
  return pointer.slice(1).split('/').map((part) => {
    const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~');
    return /^\d+$/u.test(decoded) ? Number(decoded) : decoded;
  });
}

function schemaMessage(error: SchemaValidationError, path: Array<string | number>, locale: DiagnosticLocale): string {
  const location = path.length ? path.join('.') : 'Profile';
  const messages = schemaMessages[locale];
  if (error.keyword === 'required') return messages.required(location);
  if (error.keyword === 'additionalProperties') return messages.unsupported(location);
  if (error.keyword === 'type') return messages.type(location, String(error.params.type ?? 'a supported value'));
  if (error.keyword === 'enum') return messages.enum(location);
  if (error.keyword === 'const') return messages.const(location, JSON.stringify(error.params.allowedValue));
  return messages.invalid(location, error.message ?? 'is invalid');
}

function normalizedLocale(locale: string): DiagnosticLocale { return locale === 'zh-TW' || locale === 'ja' || locale === 'ko' ? locale : 'en'; }

const schemaMessages = {
  en: { required: (p: string) => `${p} is required.`, unsupported: (p: string) => `${p} is not a supported setting.`, type: (p: string, v: string) => `${p} must be ${v}.`, enum: (p: string) => `${p} must use one of the supported values.`, const: (p: string, v: string) => `${p} must use ${v}.`, invalid: (p: string, v: string) => `${p} ${v}.` },
  'zh-TW': { required: (p: string) => `${p} 為必填設定。`, unsupported: (p: string) => `${p} 不是支援的設定。`, type: (p: string, v: string) => `${p} 必須是 ${v}。`, enum: (p: string) => `${p} 必須使用支援的值。`, const: (p: string, v: string) => `${p} 必須是 ${v}。`, invalid: (p: string, v: string) => `${p} 無效：${v}。` },
  ja: { required: (p: string) => `${p} は必須です。`, unsupported: (p: string) => `${p} はサポートされていない設定です。`, type: (p: string, v: string) => `${p} は ${v} である必要があります。`, enum: (p: string) => `${p} はサポートされている値を使用してください。`, const: (p: string, v: string) => `${p} は ${v} である必要があります。`, invalid: (p: string, v: string) => `${p} は無効です: ${v}。` },
  ko: { required: (p: string) => `${p} 설정은 필수입니다.`, unsupported: (p: string) => `${p} 설정은 지원되지 않습니다.`, type: (p: string, v: string) => `${p} 값은 ${v} 형식이어야 합니다.`, enum: (p: string) => `${p} 값은 지원되는 값이어야 합니다.`, const: (p: string, v: string) => `${p} 값은 ${v}여야 합니다.`, invalid: (p: string, v: string) => `${p} 값이 올바르지 않습니다: ${v}.` },
} satisfies Record<DiagnosticLocale, Record<string, (...values: string[]) => string>>;

const compatibilityMessages = {
  en: { environment: 'Choose an Environment so this Profile behaves consistently in every browser.', faults: 'Web cannot run network fault simulation. Use VS Code or CLI.', comparison: 'Web cannot run baseline and candidate comparisons. Use VS Code or CLI.', performance: 'Web cannot run performance regression checks without a VS Code baseline.', outputDirectory: 'Web downloads reports and does not use outputDirectory.', baselineDirectory: 'Web stores visual baselines in this browser and does not use baselineDirectory.' },
  'zh-TW': { environment: '請指定環境，讓此設定檔在不同瀏覽器中的行為一致。', faults: 'Web 無法執行網路故障模擬，請使用 VS Code 或 CLI。', comparison: 'Web 無法執行基準與候選版本比較，請使用 VS Code 或 CLI。', performance: 'Web 無法使用 VS Code 基準執行效能回歸檢查。', outputDirectory: 'Web 會下載報告，不會使用 outputDirectory。', baselineDirectory: 'Web 會將視覺基準儲存在此瀏覽器，不會使用 baselineDirectory。' },
  ja: { environment: 'どのブラウザーでも同じ動作になるように環境を指定してください。', faults: 'Web ではネットワーク障害をシミュレーションできません。VS Code または CLI を使用してください。', comparison: 'Web ではベースラインと候補を比較できません。VS Code または CLI を使用してください。', performance: 'Web では VS Code の基準を使った性能回帰チェックを実行できません。', outputDirectory: 'Web はレポートをダウンロードし、outputDirectory は使用しません。', baselineDirectory: 'Web は視覚ベースラインをこのブラウザーに保存し、baselineDirectory は使用しません。' },
  ko: { environment: '모든 브라우저에서 동일하게 작동하도록 환경을 지정하세요.', faults: 'Web에서는 네트워크 장애 시뮬레이션을 실행할 수 없습니다. VS Code 또는 CLI를 사용하세요.', comparison: 'Web에서는 기준과 후보 비교를 실행할 수 없습니다. VS Code 또는 CLI를 사용하세요.', performance: 'Web에서는 VS Code 기준을 사용하는 성능 회귀 검사를 실행할 수 없습니다.', outputDirectory: 'Web은 보고서를 다운로드하며 outputDirectory를 사용하지 않습니다.', baselineDirectory: 'Web은 시각적 기준을 이 브라우저에 저장하며 baselineDirectory를 사용하지 않습니다.' },
} satisfies Record<DiagnosticLocale, Record<string, string>>;
