# Establish repository, package, and test foundation

Type: task
Status: resolved

## Question

Create the Git repository and TypeScript OpenCode plugin package foundation, pin compatible dependencies, configure ignored runtime state, and establish unit-test, typecheck, lint, and build commands suitable for deterministic core development.

## Answer

Initialized Git on `main` and committed the wayfinder artifacts and package foundation.
Created a private ESM TypeScript package using Bun, with `@opencode-ai/plugin` pinned to active local SDK version `1.18.21` and a peer range constrained below `1.19.0`.
Added strict TypeScript configuration, declaration build, ESLint flat configuration, Bun test harness, lockfile, and runtime-state/build ignores.
The public plugin export smoke test establishes the package seam without anticipating later behavior.

Verification passed:

- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun run build`
- Standards review: no findings
- Spec review: no findings

Commits: `e30ba72` and `9e7f26e`.
