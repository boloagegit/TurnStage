export type StreamingRevealMode = 'instant' | 'event' | 'adaptive';
export type StreamingRevealPace = 'calm' | 'balanced' | 'fast';

export interface RevealPacing {
  intervalMs: number;
  initialGraphemes: number;
  minimumGraphemes: number;
}

const PACING: Record<StreamingRevealPace, RevealPacing> = {
  calm: { intervalMs: 48, initialGraphemes: 2, minimumGraphemes: 2 },
  balanced: { intervalMs: 36, initialGraphemes: 3, minimumGraphemes: 3 },
  fast: { intervalMs: 24, initialGraphemes: 5, minimumGraphemes: 5 },
};

type GraphemeSegment = { segment: string; index: number };
type Segmenter = { segment(value: string): Iterable<GraphemeSegment> };
type SegmenterConstructor = new (locale?: string | string[], options?: { granularity: 'grapheme' }) => Segmenter;

const SegmenterClass = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter = SegmenterClass ? new SegmenterClass(undefined, { granularity: 'grapheme' }) : undefined;

export function resolveRevealPacing(pace: StreamingRevealPace): RevealPacing {
  return PACING[pace];
}

/**
 * Chooses a bounded amount of work for one visual frame. The remaining
 * backlog is drained by the configured deadline without scheduling one render
 * per character.
 */
export function calculateRevealStep(backlogCodeUnits: number, maxVisualLagMs: number, intervalMs: number, elapsedMs: number): number {
  if (!Number.isFinite(backlogCodeUnits) || backlogCodeUnits <= 0) return 0;
  const safeInterval = Math.max(1, Math.round(intervalMs));
  const remainingMs = Math.max(0, maxVisualLagMs - Math.max(0, elapsedMs));
  const remainingFrames = Math.max(1, Math.floor(remainingMs / safeInterval));
  return Math.max(1, Math.ceil(backlogCodeUnits / remainingFrames));
}

/** Advance from an existing grapheme boundary without splitting emoji, CJK,
 * combining marks, or surrogate pairs. Work is proportional to the newly
 * revealed slice rather than the full accumulated response. */
export function advanceGraphemeBoundary(text: string, start: number, graphemeCount: number): number {
  const safeStart = Math.max(0, Math.min(text.length, Math.trunc(start)));
  if (safeStart >= text.length || graphemeCount <= 0) return safeStart;
  const suffix = text.slice(safeStart);
  const count = Math.max(1, Math.trunc(graphemeCount));
  if (graphemeSegmenter) {
    let seen = 0;
    for (const item of graphemeSegmenter.segment(suffix)) {
      seen += 1;
      if (seen >= count) return Math.min(text.length, safeStart + item.index + item.segment.length);
    }
    return text.length;
  }
  let offset = safeStart;
  let seen = 0;
  for (const codePoint of suffix) {
    offset += codePoint.length;
    seen += 1;
    if (seen >= count) break;
  }
  return Math.min(text.length, offset);
}
