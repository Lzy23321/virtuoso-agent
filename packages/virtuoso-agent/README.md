# Virtuoso Agent

Virtuoso automation tools for pi agent and CLI workflows.

This package is intentionally not a new agent runtime. It provides Virtuoso-specific tools and a reusable runtime that pi, CLI users, and future adapters can call.

## Managed Virtuoso sessions

Agent and CLI workflows reuse a registered Virtuoso session:

```sh
vab session start --cds-lib /path/to/cds.lib --json
vab session list --json
vab cellview show --lib worklib --cell ota --view schematic --json
```

`vab cellview open` is a compatibility alias for `vab cellview show`. Both require an existing managed UI session and never start or close Virtuoso implicitly. If no matching session exists, start one explicitly with `vab session start`.
