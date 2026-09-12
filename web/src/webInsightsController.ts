import type { HostPayload } from '../../src/shared/protocol';
import type { ConnectionDoctorFinding, ConnectionDoctorSummary, SessionSnapshot, TurnStageProfile } from '../../src/shared/types';
import { ArtifactStore } from './artifactStore';
import type { BrowserSessionState } from './browserSession';

interface VisualBaseline { dataUrl: string; viewport: { id: string; width: number; height: number } }

export class WebInsightsController {
  private readonly store = new ArtifactStore();

  constructor(private readonly profile: () => TurnStageProfile, private readonly session: () => BrowserSessionState, private readonly post: (payload: HostPayload, requestId?: string) => void) {}

  analyzeConnection(): void {
    const profile = this.profile();
    const state = this.session();
    const snapshot = state.snapshot;
    const network = [...state.networkEntries].reverse().find((item) => item.kind === 'stream') ?? state.networkEntries.at(-1);
    const protocol = profile.stream.transport === 'fixture' ? 'unknown' : profile.stream.transport;
    const terminal = snapshot.normalizedEvents.find((item) => ['conversation.completed', 'conversation.failed', 'message.completed', 'message.failed'].includes(item.type));
    const findings: ConnectionDoctorFinding[] = [];
    if (!network) findings.push(finding('http', 'warning', 'No browser request has been captured yet. Send a request before analyzing the connection.'));
    else if (network.status && (network.status < 200 || network.status >= 300)) findings.push(finding('http', 'error', `The latest response returned HTTP ${network.status}.`));
    if (snapshot.metrics.parseErrorCount) findings.push(finding('protocol', 'error', `${snapshot.metrics.parseErrorCount} stream event(s) could not be parsed.`));
    if (snapshot.metrics.mappingErrorCount) findings.push(finding('mapping', 'error', `${snapshot.metrics.mappingErrorCount} mapping rule error(s) were observed.`));
    if (snapshot.metrics.unmatchedEventCount) findings.push(finding('mapping', 'warning', `${snapshot.metrics.unmatchedEventCount} event(s) did not match any mapping rule.`));
    if (snapshot.rawEvents.length && !terminal) findings.push(finding('terminal', 'warning', 'No mapped terminal event was observed; verify doneValue or terminal mappings.'));
    if (network?.timing.firstChunk !== undefined && network.timing.firstChunk > 5_000) findings.push(finding('timing', 'warning', `The first chunk arrived after ${Math.round(network.timing.firstChunk)} ms.`));
    if (!findings.length) findings.push(finding('stream', 'info', 'The captured browser request, stream parsing, mappings, and terminal event are consistent.'));
    const safe = Boolean(network && (!network.status || network.status < 400) && !snapshot.metrics.parseErrorCount && !snapshot.metrics.mappingErrorCount && !snapshot.metrics.unmatchedEventCount && (snapshot.rawEvents.length === 0 || terminal));
    const summary: ConnectionDoctorSummary = { protocol, confidence: network && snapshot.rawEvents.length ? 'high' : network ? 'medium' : 'low', ...(network?.status ? { status: network.status } : {}), rawEventCount: snapshot.rawEvents.length, normalizedEventCount: snapshot.normalizedEvents.length, mappedEventCount: snapshot.rawEvents.filter((item) => item.mappingRuleId).length, unmatchedEventCount: snapshot.metrics.unmatchedEventCount, parseErrorCount: snapshot.metrics.parseErrorCount, mappingErrorCount: snapshot.metrics.mappingErrorCount, terminalEventSeen: Boolean(terminal), terminalMapped: Boolean(terminal), safe, findings, networkPath: { runtime: 'local', proxySupport: 'unknown', proxyConfigured: false, environmentProxyConfigured: false, noProxyConfigured: false, systemCertificates: true, proxyStrictSSL: true, useLocalProxyConfiguration: false, viaHeaderObserved: Boolean(network?.responseHeaders?.via), tlsVerification: 'strict', route: 'unknown', confidence: 'low', findings: [] } };
    this.post({ type: 'connection.result', result: summary });
  }

  async saveBaseline(dataUrl: string, viewport: VisualBaseline['viewport']): Promise<void> {
    const profile = this.profile();
    const id = `${profile.id}:${viewport.id}`;
    const value = { dataUrl, viewport };
    await this.store.put<VisualBaseline>('visualBaselines', { id, profileId: profile.id, kind: 'visual', name: viewport.id, updatedAt: Date.now(), value });
    this.post({ type: 'visual.result', operation: 'baseline', status: 'saved', baselinePath: `browser://visual-baseline/${id}` });
  }

  async compare(dataUrl: string, viewport: VisualBaseline['viewport']): Promise<void> {
    const profile = this.profile();
    const id = `${profile.id}:${viewport.id}`;
    const baseline = await this.store.get<VisualBaseline>('visualBaselines', id);
    if (!baseline) throw new Error(`No browser-local baseline exists for viewport ${viewport.id}.`);
    const differencePercent = await pixelDifference(baseline.value.dataUrl, dataUrl, baseline.value.viewport, viewport);
    this.post({ type: 'visual.result', operation: 'compare', status: differencePercent === 0 ? 'passed' : 'failed', differencePercent, baselinePath: `browser://visual-baseline/${id}`, ...(differencePercent ? { diffPath: `browser://visual-diff/${id}` } : {}) });
  }
}

function finding(category: ConnectionDoctorFinding['category'], severity: ConnectionDoctorFinding['severity'], message: string): ConnectionDoctorFinding { return { id: `${category}-${severity}-${message.slice(0, 24).replaceAll(/\W+/gu, '-').toLowerCase()}`, category, severity, message }; }

async function pixelDifference(leftUrl: string, rightUrl: string, leftViewport: VisualBaseline['viewport'], rightViewport: VisualBaseline['viewport']): Promise<number> {
  if (leftViewport.width !== rightViewport.width || leftViewport.height !== rightViewport.height) return 100;
  const [left, right] = await Promise.all([imageData(leftUrl, leftViewport.width, leftViewport.height), imageData(rightUrl, rightViewport.width, rightViewport.height)]);
  let changed = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    if (Math.abs(left.data[index]! - right.data[index]!) > 8 || Math.abs(left.data[index + 1]! - right.data[index + 1]!) > 8 || Math.abs(left.data[index + 2]! - right.data[index + 2]!) > 8 || Math.abs(left.data[index + 3]! - right.data[index + 3]!) > 8) changed += 1;
  }
  return Math.round((changed / (left.width * left.height)) * 10_000) / 100;
}

async function imageData(dataUrl: string, width: number, height: number): Promise<ImageData> {
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas === 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext('2d');
  } else {
    const canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d');
  }
  if (!context) throw new Error('The browser could not create a canvas for visual comparison.');
  context.drawImage(image, 0, 0, width, height);
  image.close();
  return context.getImageData(0, 0, width, height);
}

export function browserDiagnostic(profile: TurnStageProfile, snapshot: SessionSnapshot, mode: string): string {
  const errors = snapshot.errors.map((item) => `${item.type}: ${item.message}`);
  return [`TurnStage Web ${mode} diagnostic`, `Profile: ${profile.name} (${profile.id})`, `State: ${snapshot.sessionState} / ${snapshot.turnState}`, `Events: ${snapshot.rawEvents.length} raw, ${snapshot.normalizedEvents.length} normalized`, `Parse errors: ${snapshot.metrics.parseErrorCount}; mapping errors: ${snapshot.metrics.mappingErrorCount}; unmatched: ${snapshot.metrics.unmatchedEventCount}`, ...(errors.length ? ['Errors:', ...errors.map((item) => `- ${item}`)] : ['No runtime errors were captured.']), '', 'This deterministic browser report contains no AI-generated claims.'].join('\n');
}
