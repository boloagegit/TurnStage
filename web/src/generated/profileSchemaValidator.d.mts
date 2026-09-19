export interface SchemaValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface ProfileSchemaValidator {
  (value: unknown): boolean;
  errors?: SchemaValidationError[] | null;
}

export const validateProfile: ProfileSchemaValidator;

