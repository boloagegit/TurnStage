import { applyEdits, modify, parse } from 'jsonc-parser';
import { localize } from '../l10n';

export interface MigrationResult { changed: boolean; fromVersion: number; toVersion: number; text: string; notes: string[] }

export class ProfileMigrator {
  migrate(text: string): MigrationResult {
    const value = parse(text, [], { allowTrailingComma: true }) as Record<string, unknown>;
    const version = typeof value?.version === 'number' ? value.version : 0;
    if (version === 1) return { changed: false, fromVersion: 1, toVersion: 1, text, notes: [] };
    if (version !== 0) throw new Error(localize('No migration is available for version {version}.', { version }));
    let migrated = text;
    const edits = modify(migrated, ['version'], 1, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); migrated = applyEdits(migrated, edits);
    return { changed: true, fromVersion: 0, toVersion: 1, text: migrated, notes: [localize('Set profile version to 1. Review the profile against the current schema.')] };
  }
}
