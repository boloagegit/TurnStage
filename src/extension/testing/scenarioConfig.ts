export function isSafeReportDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.includes('://')) return false;
  const segments = value.split('/');
  return segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}
