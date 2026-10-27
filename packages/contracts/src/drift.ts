// Compile-time guard: tsc fails if the zod schemas diverge from docs/spec/openapi.yaml.
import type { z } from 'zod';
import type { components } from './generated/openapi.js';
import type { ReliefRequest, ReliefRequestInput, ReliefStatusPatch } from './relief.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Schemas = components['schemas'];

export type Drift = [
  Expect<Equal<z.infer<typeof ReliefRequestInput>, Schemas['ReliefRequestInput']>>,
  Expect<Equal<z.infer<typeof ReliefRequest>, Schemas['ReliefRequest']>>,
  Expect<Equal<z.infer<typeof ReliefStatusPatch>['status'], Schemas['RequestStatus']>>,
];
