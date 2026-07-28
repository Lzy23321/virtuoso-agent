# Virtuoso Agent

Virtuoso automation tools for pi agent and CLI workflows.

This package is intentionally not a new agent runtime. It provides Virtuoso-specific tools and a reusable runtime that pi, CLI users, and future adapters can call.

## Managed Virtuoso sessions

Agent and CLI workflows reuse a registered Virtuoso session:

```sh
vab session start --cds-lib /path/to/cds.lib --json
vab session list --json
vab cellview show --lib worklib --cell ota --view schematic --json
vab schematic export --lib worklib --cell ota_tb --view schematic --json
vab maestro export --lib worklib --cell ota_tb --view maestro --json
```

`vab cellview open` is a compatibility alias for `vab cellview show`. Both require an existing managed UI session and never start or close Virtuoso implicitly. If no matching session exists, start one explicitly with `vab session start`.

## Cadence-native simulation bundles

Schematic and Maestro reads are exported from the existing managed Virtuoso process. The package does not reconstruct topology or Maestro setup data as a custom manifest.

- Schematic export saves the complete Cadence Spectre netlist directory, with `input.scs` as the primary artifact.
- Maestro export saves three OCEAN artifact classes: the top-level Assembler script at `maestro/maestro.ocn`, plus `single.ocn` and `sweep.ocn` under every `tests/<index>/` directory. Every discovered test also receives a complete Spectre netlist directory.
- Maestro export accepts `scope: "all" | "top" | "tests" | "test"`. `all` is the default, while `test` also requires the exact Maestro `testName`. The CLI equivalents are `--scope` and `--test`.
- Export never calls `run()` and does not launch a separate `ocean` or `virtuoso` process.
- `bundle.json` only records target identity, test discovery, artifact paths, hashes, provenance, and file-level validation.

Bundles are written under `<project>/.virtuoso-agent/bundles/` by default. Large Cadence files stay on disk; tool results return their paths.
