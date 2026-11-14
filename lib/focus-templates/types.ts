// Derived from https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/type-design-analyzer.md @ b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6.
// Licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Changed: rewrote four rating axes as deficiency checks; removed per-type reports, strengths, invocation and output idioms; scoped to introduced defects and added pragmatic severity guidance.
export const types = {
  id: "types",
  label: "Types",
  description: "Find introduced type deficiencies that weaken real invariants.",
  source: "https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/type-design-analyzer.md",
  sourceSha: "b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6",
  license: "Apache-2.0",
  holder: "Anthropic, PBC",
  instructions: `Find deficiencies in type designs added or changed by the diff, including existing invariants broken by changed construction or mutation. Skip pre-existing design weaknesses. Report deficiencies only: no per-type ratings, inventories or strengths.

Establish the real invariants from usage and contracts: data consistency, valid state transitions, relationships between fields, business rules, preconditions and postconditions. Do not invent constraints from what a type's name suggests.

Examine four aspects:
1. Encapsulation: can external code mutate exposed internals or bypass the operations that maintain an invariant? Are access boundaries sufficient for actual callers?
2. Invariant expression: does the structure permit illegal combinations of fields or obscure distinctions callers must preserve? Could an appropriate compile-time guarantee prevent a demonstrated invalid state?
3. Usefulness: does the constraint prevent a real bug and match business requirements, or is it so restrictive that valid operations require unsafe escapes? Do not recommend a stronger type without a concrete benefit.
4. Enforcement: are constructors and deserialization boundaries validated where needed? Are all relevant mutation paths guarded consistently? A static type assertion does not validate runtime input. Check whether callers or existing boundary validators already enforce the requirement.

Investigate exposed mutable internals, documentation-only invariants, missing construction validation, inconsistent mutation checks and reliance on external code to keep objects valid. Treat anemic data records or types with several responsibilities as clues, not automatic findings.

For a deficiency, describe the invalid state the introduced code allows, a reachable construction or mutation path, and the resulting consequence. Suggest the smallest correction. Prefer compile-time guarantees where feasible, constructor validation where runtime input requires it, and immutability where it simplifies the actual invariant. Respect language and repository conventions.

Balance safety with usability, performance, maintenance cost and breaking changes. A simple record with validated boundaries may be better than a complex domain abstraction. Do not recommend wrappers, accessors or redesign merely for architectural purity.

Use Should fix for a concrete invariant hole with a plausible erroneous use supported by code. Reserve Blocking for a reachable violation that makes merging unsafe, such as bypassing an authorization state or corrupting persisted data. Optional expressiveness improvements are at most Nit; uncertainty about an undocumented requirement does not justify escalation.`,
} as const;
