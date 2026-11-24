// Big Bundle Wright: generate the test fixtures once, before any test file runs
// (test files run in parallel and would otherwise regenerate them over each other).
// SPDX-License-Identifier: MPL-2.0
import { generate } from './fixtures/generate.ts';

export default async function setup() {
  await generate();
}
