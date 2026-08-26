import { parse, parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { TurnStageProfile } from '../../shared/types';

export interface ParsedProfile { profile?: TurnStageProfile; errors: ParseError[]; tree?: Node }

export class ProfileCodec {
  parse(text: string): ParsedProfile {
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
    return { profile: errors.length === 0 && value && typeof value === 'object' ? value as TurnStageProfile : undefined, errors, tree: parseTree(text, [], { allowTrailingComma: true, disallowComments: false }) };
  }
}
