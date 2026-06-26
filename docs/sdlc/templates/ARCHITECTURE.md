# Architecture — <project>

> Producer: architect. Location: `docs/sdlc/architecture/ARCHITECTURE.md`. The always-current system map; ADRs are
> the decision records it links to. Updated on every architectural change (code-review blocks if it wasn't).

## Overview
<one paragraph: what the system is and the architectural style (layered / hexagonal / MVVM)>

## Components & layers
<the modules/services and how they map to presentation → application → domain → infrastructure>

## Diagram
```
<ascii or mermaid block: components, boundaries, dependencies (arrows point toward abstractions)>
```

## Data flow
<how a representative request/operation flows through the layers>

## Key decisions (ADRs)
- ADR-0001 — <stack & reference architecture>
- ADR-<n> — <decision> → `docs/sdlc/architecture/ADR-<n>-<slug>.md`

## Extensibility points & boundaries
<where new behavior plugs in; the boundaries that must not be crossed>
