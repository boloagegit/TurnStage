export type L10nValues = Record<string, string | number | boolean>;
type Translator = (message: string, values?: L10nValues) => string;

let translator: Translator = (message, values = {}) => message.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]));

export function configureL10n(next: Translator): void {
  translator = next;
}

export function localize(message: string, values?: L10nValues): string {
  return translator(message, values);
}
