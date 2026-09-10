import { defineSchema, type RuntimeSchema } from "intention-kernel";
import { z } from "zod";

/** Adapt a Zod schema without exposing Zod through the kernel contract. */
export function schemaFromZod<T>(schema: z.ZodType<T>): RuntimeSchema<T> {
  return defineSchema({
    vendor: "zod",
    validate(value) {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { value: parsed.data }
        : { issues: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
    },
    jsonSchema: () => z.toJSONSchema(schema),
  });
}
