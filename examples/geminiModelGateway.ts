import { GoogleGenAI } from "@google/genai";
import {
  ModelGatewayError,
  type ModelGateway,
  type ModelRequest,
  type ModelResult,
} from "intention-kernel";

/** Options for the production-shaped Gemini adapter used by the demos. */
export interface GeminiModelGatewayOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

/** Provider adapter that maps the generic model contract to Gemini JSON output. */
export class GeminiModelGateway implements ModelGateway {
  readonly #client: GoogleGenAI;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: GeminiModelGatewayOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("GEMINI_API_KEY_REQUIRED");
    if (options.model.trim().length === 0) throw new Error("GEMINI_MODEL_REQUIRED");
    this.#client = new GoogleGenAI({ apiKey: options.apiKey });
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async invoke<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const responseSchema = await request.outputSchema.jsonSchema?.();
    if (responseSchema === undefined) {
      throw new ModelGatewayError({
        code: "MODEL_SCHEMA_UNAVAILABLE",
        message: "The selected model adapter requires a JSON Schema projection.",
        retryable: false,
        context: { task: request.task },
      });
    }
    const startedAt = performance.now();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.#timeoutMs)]);
    try {
      const response = await this.#client.models.generateContent({
        model: request.model ?? this.#model,
        contents: JSON.stringify({
          task: request.task,
          input: request.input,
          capabilities: request.capabilities,
        }),
        config: {
          systemInstruction: request.system,
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema,
          temperature: request.task.startsWith("response.compose") ? 0.15 : 0,
          maxOutputTokens: 4_096,
          abortSignal: signal,
        },
      });
      if (typeof response.text !== "string" || response.text.trim().length === 0) {
        throw new ModelGatewayError({
          code: "MODEL_EMPTY_RESPONSE",
          message: "Gemini returned no structured response.",
          retryable: true,
          context: { task: request.task, model: this.#model },
        });
      }
      let value: unknown;
      try {
        value = JSON.parse(response.text);
      } catch (error) {
        throw new ModelGatewayError({
          code: "MODEL_JSON_INVALID",
          message: "Gemini returned malformed JSON.",
          retryable: false,
          context: { task: request.task, model: this.#model },
          cause: error,
        });
      }
      return {
        value: value as T,
        provider: "gemini",
        model: response.modelVersion ?? this.#model,
        durationMs: Math.round(performance.now() - startedAt),
        usage: {
          ...(response.usageMetadata?.promptTokenCount === undefined
            ? {}
            : { inputTokens: response.usageMetadata.promptTokenCount }),
          ...(response.usageMetadata?.candidatesTokenCount === undefined
            ? {}
            : { outputTokens: response.usageMetadata.candidatesTokenCount }),
        },
      };
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError({
        code: signal.aborted ? "MODEL_REQUEST_ABORTED" : "MODEL_PROVIDER_FAILURE",
        message: signal.aborted
          ? "The model request was cancelled or timed out."
          : "Gemini could not complete the structured request.",
        retryable: signal.aborted,
        context: { task: request.task, model: request.model ?? this.#model },
        cause: error,
      });
    }
  }
}
