import * as vscode from 'vscode';
import type { PreparedRequest, RequestDefinition, TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { sha256Hex } from '../../shared/sha256';
import { localize } from '../l10n';

const STORAGE_KEY = 'turnstage.requestAuthorizations.v1';
const MAX_GRANTS = 200;

export type RequestAuthorizationPurpose = 'opening' | 'conversation' | 'stop';

export interface RequestAuthorizationAssessment {
  required: boolean;
  destination: string;
  hasSecrets: boolean;
  invalidCertificates: boolean;
  cleartextSecrets: boolean;
  automaticOpening: boolean;
}

interface StoredGrant {
  version: 1;
  fingerprint: string;
  createdAt: number;
}

/**
 * Remembers consent for security-relevant Profile requests without persisting
 * endpoints, secret names, or request contents. A changed destination,
 * request definition, secret mapping, or TLS mode produces a new fingerprint.
 */
export class RequestAuthorizationService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async authorize(
    profileUri: vscode.Uri,
    profile: TurnStageProfile,
    environment: TurnStageEnvironment,
    request: PreparedRequest,
    purpose: RequestAuthorizationPurpose,
    hasSecrets: boolean,
  ): Promise<boolean> {
    if (!vscode.workspace.isTrusted) return false;
    const assessment = assessRequestAuthorization(request, purpose, hasSecrets);
    if (!assessment.required) return true;
    const fingerprint = requestAuthorizationFingerprint(profileUri, profile, environment, request, purpose, assessment);
    if (this.read().some((grant) => grant.fingerprint === fingerprint)) return true;

    const remember = localize('Allow this Profile');
    const once = localize('Allow once');
    const choice = await vscode.window.showWarningMessage(
      localize('Allow this TurnStage Profile to connect?'),
      { modal: true, detail: authorizationDetail(profile, request, assessment) },
      remember,
      once,
    );
    if (!vscode.workspace.isTrusted) return false;
    if (choice === once) return true;
    if (choice !== remember) return false;
    const next: StoredGrant[] = [{ version: 1 as const, fingerprint, createdAt: Date.now() }, ...this.read().filter((grant) => grant.fingerprint !== fingerprint)].slice(0, MAX_GRANTS);
    await this.context.workspaceState.update(STORAGE_KEY, next);
    return true;
  }

  private read(): StoredGrant[] {
    const stored = this.context.workspaceState.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is StoredGrant => {
      if (!value || typeof value !== 'object') return false;
      const grant = value as Partial<StoredGrant>;
      return grant.version === 1
        && typeof grant.fingerprint === 'string'
        && /^[a-f0-9]{64}$/u.test(grant.fingerprint)
        && typeof grant.createdAt === 'number'
        && Number.isFinite(grant.createdAt);
    }).slice(0, MAX_GRANTS);
  }
}

export function assessRequestAuthorization(request: PreparedRequest, purpose: RequestAuthorizationPurpose, hasSecrets: boolean): RequestAuthorizationAssessment {
  const target = safeUrl(request.url);
  const loopback = target ? isLoopbackHost(target.hostname) : false;
  const invalidCertificates = request.tls?.allowInvalidCertificates === true;
  const cleartextSecrets = target?.protocol === 'http:' && hasSecrets && !loopback;
  const automaticOpening = purpose === 'opening' && !loopback;
  return {
    required: invalidCertificates || Boolean(cleartextSecrets) || automaticOpening,
    destination: displayDestination(safeUrl(request.redacted.url)),
    hasSecrets,
    invalidCertificates,
    cleartextSecrets: Boolean(cleartextSecrets),
    automaticOpening,
  };
}

export function requestAuthorizationFingerprint(
  profileUri: vscode.Uri,
  profile: TurnStageProfile,
  environment: TurnStageEnvironment,
  request: PreparedRequest,
  purpose: RequestAuthorizationPurpose,
  assessment = assessRequestAuthorization(request, purpose, Boolean(request.secretValues?.length)),
): string {
  const target = safeUrl(request.url);
  const material = stableStringify({
    version: 1,
    profileUri: profileUri.toString(),
    profileId: profile.id,
    environmentId: environment.id,
    secretReferences: environment.secretReferences ?? {},
    purpose,
    method: request.method.toUpperCase(),
    destination: target ? `${target.origin}${target.pathname}` : '[invalid-url]',
    definition: requestDefinition(profile, purpose),
    hasSecrets: assessment.hasSecrets,
    invalidCertificates: assessment.invalidCertificates,
  });
  return sha256Hex(material);
}

function authorizationDetail(profile: TurnStageProfile, request: PreparedRequest, assessment: RequestAuthorizationAssessment): string {
  const reasons = [
    assessment.automaticOpening ? localize('This request starts automatically when the Profile opens.') : undefined,
    assessment.cleartextSecrets ? localize('This HTTP request contains secret values and is not encrypted.') : undefined,
    assessment.invalidCertificates ? localize('Certificate verification is disabled for this request.') : undefined,
  ].filter((value): value is string => Boolean(value));
  return [
    `${localize('Profile')}: ${boundedDisplay(profile.name, 160)}`,
    `${localize('Destination')}: ${assessment.destination}`,
    `${localize('Request')}: ${request.method.toUpperCase()}`,
    `${localize('Uses secrets')}: ${assessment.hasSecrets ? localize('Yes') : localize('No')}`,
    `${localize('TLS verification')}: ${assessment.invalidCertificates ? localize('Disabled') : localize('Enabled')}`,
    '',
    ...reasons,
    '',
    localize('TurnStage will ask again if the destination, secret references, or TLS settings change.'),
  ].join('\n');
}

function requestDefinition(profile: TurnStageProfile, purpose: RequestAuthorizationPurpose): RequestDefinition | undefined {
  if (purpose === 'opening') return profile.opening?.request;
  if (purpose === 'stop') return profile.conversation.stop?.request;
  return profile.conversation.send;
}

function safeUrl(value: string): URL | undefined { try { return new URL(value); } catch { return undefined; } }

function displayDestination(target: URL | undefined): string {
  if (!target) return '[invalid-url]';
  const path = target.pathname.length > 160 ? `${target.pathname.slice(0, 159)}…` : target.pathname;
  return `${target.protocol}//${target.host}${path}`;
}

function boundedDisplay(value: string, maximum: number): string {
  const normalized = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (value === 'localhost' || value === '::1') return true;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  return Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255) && Number(ipv4[1]) === 127);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
