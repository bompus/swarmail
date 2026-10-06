# Validator research, 2026-10-06

Research snapshot for Swarmail's three structured mail result schemas at
`dda19b36fb7a3127a981be1153d71c57f62d5fe5`. The experiments below informed the direct-check implementation in
`src/message-validation.ts`. Ajv remains a development/test reference; production
validation uses JavaScript checks. No release or host deployment is implied.

## What was tested

Pinned versions: Ajv 8.20.0, TypeBox 1.3.36 (`typebox`), Zod 4.6.5,
Valibot 1.5.0 and Typia 15.1.0. Tests used Bun 1.4.2; the final generated
TypeBox artifacts also ran on Node 26.10.0.

The broad correctness screen covered 348 cases. The final TypeBox screen
expanded this to 357 cases: 51 accepted and 306 rejected. Cases included
closed and nested objects, historical replay, required and optional fields
assigned `undefined`, nonfinite numbers, fractions and integer ranges.
Deep comparisons checked that validation did not change the input.

These are synthetic contract cases, not production traffic. The scratch
harness and raw receipts were retained outside the repository; this document
records the findings, not a checked-in benchmark reproduction.

## Options and qualification

| Option | Finding | Remaining cost or limit |
| --- | --- | --- |
| Ajv reference | Independent advertised-schema checks in development/tests | Development dependency |
| Ajv standalone | 348 acceptance/rejection cases pass; original 310 cases preserve detailed errors | Generate modules and check regeneration; product integration still needed |
| TypeBox runtime | 357 cases pass with explicit fresh-message branch fields | Runtime package; detailed errors differ from Ajv |
| TypeBox generated | Same 357 cases pass on Bun and Node, with no external runtime imports | Initialize captured values, bundle and check regeneration |
| Zod and Zod Mini | Explicit schema definitions pass the broad screen | Direct JSON Schema conversion failed 28 cases; conversion/refinements need maintenance |
| Valibot | Explicit schema definitions pass the broad screen | Different schema API and diagnostics; no confirmed throughput advantage |
| Typia | Transformer execution was not qualified | Compiler integration and contract parity remain untested |
| Direct checks | 375 synthetic cases agree with Ajv, including inherited fields and sparse arrays | Duplicate contract definitions need independent schema-parity tests |

### TypeBox needs an explicit branch definition

A direct TypeBox compiler swap failed six cases involving fresh-message
`delivery` or `revision` assigned `undefined`. Define those fields explicitly
inside the fresh-message `anyOf` branch, reusing their property schemas.
That candidate passed all 357 cases without changing the inputs.

A global strict-optional setting rejected 12 valid historical or optional
cases. Do not use that setting as a compatibility workaround. These results
are specific to the tested schemas; they are not a general JSON Schema
conformance assessment.

### Supported generation removes the custom-emitter objection

TypeBox 1.3.36 exports `Code()` from `typebox/compile`. It emits an ES module
and returns captured values separately through `External`. The module
exports `SetExternal()` for initialization. Earlier research missed this
API and overstated the need to assemble function bodies manually.

The tested generation sequence was:

1. Call `Code(schema)` for each of the three schemas and write its module.
2. Initialize its captures through `SetExternal()`. All seven captures were
   regular expressions; serialize their source and flags. Reject other
   capture types rather than silently generating an invalid module.
3. Bundle the entry with `Bun.build`, using ESM and minification.
4. Verify zero output imports in the bundler metadata and repeat generation
   to check identical output.
5. Run acceptance, rejection and input-preservation checks without TypeBox
   installed. Node also passed with
   `--disallow-code-generation-from-strings`.

No TypeBox source patches, custom validator engine or custom function-body
emitter were needed. New schema features or capture types require renewed
qualification.

## Module sizes and diagnostics

| Tested validator module | Minified bytes | Gzip bytes | Detailed runtime errors |
| --- | ---: | ---: | --- |
| Current Ajv | 127,960 | 38,997 | Yes |
| Generated Ajv | 51,295 | 4,912 | Yes |
| Generated TypeBox checks | 13,896 | 1,961 | No |
| Generated TypeBox checks plus `Schema.Errors` | 65,825 | 15,125 | Yes |

These are validator-module sizes, not complete server binaries. The variants
have different diagnostic capabilities. A boolean-only Ajv artifact was not
measured, so these figures do not establish relative engine efficiency.

TypeBox's detailed error arrays differed from Ajv on all 306 rejected cases.
The generic client error and transaction rollback must remain unchanged.
The selected design preference is boolean-only production checks, with
richer diagnostics available in development and tests. Production uses boolean-only direct checks; no generated artifact is needed.

## Dependencies and performance claims

Generated TypeBox can be development-only as an installed package. Its
bundled artifact still contains third-party code. The boolean artifact even
retained 605 bytes of hashing setup reported by the Bun metafile.

A committed artifact lets production-only installs avoid the generator.
Before claiming zero runtime package dependencies, verify the full product
import graph, binary, CLI and installation paths. Schema builder adoption
and inferred result types do not follow automatically from replacing the
validation engine.

Repeated comparative timing did not complete under the required isolation
conditions. No throughput, latency or server-startup winner was established.
Do not rank libraries using unrelated framework benchmark numbers.

## Elysia 2 relevance

Elysia 2's inspected `kiana` revision uses the TypeBox 1.3 package family.
Stable Elysia 1.4's `@sinclair/typebox` dependency does not establish the
requirements for Elysia 2. TypeBox has its own compiler and does not require
Ajv.

The author's build-time compilation results support evaluating startup and
compilation separately from request throughput. Framework routes without
validation schemas cannot establish validator throughput. `t.Accelerate`
was described as alpha; equivalence for arbitrary refinements and transforms
was not established by this research.

This does not qualify Elysia route generation, Workers deployment, an ODM,
input transformations or another application's contracts. Those need their
own fixtures and integration checks.

## Direct checks for the current contracts

The direct-check prototype agreed with Ajv on 357 contract cases plus 18
JavaScript object/array cases on Bun and Node, without changing the inputs.
The extra cases covered inherited required fields, inherited extra fields,
nonenumerable fields, null-prototype objects and sparse arrays. Node also ran
the original contract corpus without runtime packages or string code generation.

The production checks keep the advertised JSON Schemas separate. Tests compile
those schemas with Ajv and compare acceptance against the production checks.
Every tool with an output schema must also declare its result check; the tool
union enforces that pairing. Validation and serialization stay inside the
existing transaction, and clients retain the generic validation failure.

Direct checks suit these small, closed output contracts. They duplicate field
rules, so schema changes require updating both definitions and their parity
coverage. They do not implement arbitrary JSON Schema, transforms, refinements
or detailed runtime diagnostics. A larger contract surface could favor a
maintained compiler or schema library instead.

## Recommendation and dependency lesson

For Swarmail's current contracts, direct checks avoid a runtime validator
package and generated-artifact wiring. Keep Ajv as an independent development
reference. This is a maintenance choice; no measured speed advantage is claimed.
TypeBox's supported generator remains a qualified alternative when schema
features or reuse justify it. Typia remains unqualified here.

Before adding a validator, compare the required behavior with direct logic and
maintained alternatives. Separate runtime packages from development tooling,
and compare feature coverage, upkeep, size and measured performance where it
matters. Mark missing measurements explicitly. Dependency count alone does not
justify weakening validation or hand-writing a general validation engine.

## Primary sources

- [Ajv standalone generation](https://ajv.js.org/standalone.html).
- [TypeBox source and compiler documentation](https://github.com/sinclairzx81/typebox).
- [Elysia 2 inspected package manifest](https://github.com/elysiajs/elysia/blob/7d4923a5670493a3dbd81634e177fd2f350f13e0/package.json).
- [Elysia 2 announcement](https://elysiajs.com/blog/elysia-20).
- [Pinned framework benchmark](https://github.com/SaltyAom/bun-http-framework-benchmark/tree/ba1520ccacfb4a1783a3211b1c9682e8c8e43870).
- [Zod compiler documentation](https://zod.dev/compile).
- [Valibot comparison](https://valibot.dev/guides/comparison/).
- [Typia compiler setup](https://typia.io/docs/setup/).
