# ADR-<n> — <title>

> Producer: architect. Location: `docs/sdlc/architecture/ADR-<n>-<slug>.md`. Status: Proposed | Accepted | Superseded.

## Context
<the forces, constraints, and the decision to be made>

## Decision
<what we will do — patterns by name, layering, interfaces, data model>

## Consequences
<trade-offs, what becomes easier/harder, extensibility points, risks>

## Test strategy & coverage targets
<how the design is tested; per-layer coverage targets to hit the gate>

<!-- Stack-decision ADRs ALSO include: -->
## Stack & reference architecture  (stack-decision ADRs only)
<chosen stack + the layered/hexagonal or MVVM reference architecture>

## Mandated quality tooling  (stack-decision ADRs only)
CI gate set (authoritative): lint · format:check · typecheck · layering · duplication · test+coverage · build · SCA · gitleaks.
Local hooks (fast feedback only): <commands>. Coverage threshold: <≥80–85% line+branch on business logic>.
