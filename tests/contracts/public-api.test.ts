import { expectTypeOf, test } from "vitest";

import type {
  CapabilityDefinition,
  CapabilityResult,
  IntentionBatch,
  KernelCheckpoint,
  ModelGateway,
  TurnPlan,
} from "../../src/index.js";

test("publishes the core contracts without provider types", () => {
  expectTypeOf<CapabilityDefinition<unknown, unknown>>().toBeObject();
  expectTypeOf<CapabilityResult<unknown>>().toBeObject();
  expectTypeOf<IntentionBatch>().toBeObject();
  expectTypeOf<TurnPlan>().toBeObject();
  expectTypeOf<KernelCheckpoint>().toBeObject();
  expectTypeOf<ModelGateway>().toBeObject();
});
