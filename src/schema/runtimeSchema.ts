/** JSON Schema representation accepted by model adapters. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Normalized schema issue independent of the validation vendor. */
export interface ValidationIssue {
  /** Vendor-normalized validation explanation. */
  readonly message: string;
  /** Property path from the validation root. */
  readonly path: readonly (string | number)[];
}

/** Result of validating untrusted data. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Vendor-neutral runtime schema used at every trust boundary. */
export interface RuntimeSchema<T> {
  /** Validator or adapter name used for diagnostics. */
  readonly vendor: string;
  /** Validate an untrusted value and return a normalized result. */
  readonly validate: (value: unknown) => Promise<ValidationResult<T>>;
  /** Optional provider-neutral schema projection used for structured models. */
  readonly jsonSchema?: () => JsonSchema | Promise<JsonSchema>;
}

/** Input accepted by {@link defineSchema}. */
export interface SchemaDefinition<T> {
  /** Validator or adapter name used for diagnostics. */
  readonly vendor: string;
  /** Vendor adapter that returns either a typed value or normalized issues. */
  readonly validate: (
    value: unknown,
  ) =>
    | { readonly value: T; readonly issues?: undefined }
    | { readonly issues: readonly { readonly message: string; readonly path?: readonly PropertyKey[] }[] }
    | Promise<
        | { readonly value: T; readonly issues?: undefined }
        | { readonly issues: readonly { readonly message: string; readonly path?: readonly PropertyKey[] }[] }
      >;
  /** Optional JSON Schema projection required for model-visible capability inputs. */
  readonly jsonSchema?: () => JsonSchema | Promise<JsonSchema>;
}

/**
 * Define a vendor-neutral schema and normalize all validation results.
 *
 * @returns A frozen asynchronous runtime validator.
 */
export function defineSchema<T>(definition: SchemaDefinition<T>): RuntimeSchema<T> {
  const schema: RuntimeSchema<T> = {
    vendor: definition.vendor,
    validate: async (value) => {
      const result = await definition.validate(value);
      if (result.issues !== undefined) {
        return {
          ok: false,
          issues: result.issues.map((issue) => ({
            message: issue.message,
            path: (issue.path ?? []).map((part) =>
              typeof part === "number" ? part : String(part),
            ),
          })),
        };
      }
      return { ok: true, value: result.value };
    },
    ...(definition.jsonSchema === undefined ? {} : { jsonSchema: definition.jsonSchema }),
  };
  return Object.freeze(schema);
}
