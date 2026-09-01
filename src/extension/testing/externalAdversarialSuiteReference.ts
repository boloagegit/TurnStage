const REFERENCE = /^external:([0-9a-f-]{36}):([^/\\]{1,180})$/iu;

/** An opaque reference whose real URI remains in local extension state. */
export function isExternalAdversarialSuiteReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && REFERENCE.test(value);
}
