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
vab schematic export --lib worklib --cell ota_tb --view schematic --netlist none --schematic-instances top-level --json
vab maestro export --lib worklib --cell ota_tb --view maestro --json
vab maestro export --lib worklib --cell ota_tb --view maestro --outputs all --history Interactive.1 --json
vab maestro export --lib worklib --cell ota_tb --view maestro --schematic-instances top-level --json
```

`vab cellview open` is a compatibility alias for `vab cellview show`. Both require an existing managed UI session and never start or close Virtuoso implicitly. If no matching session exists, start one explicitly with `vab session start`.

## Cadence-native simulation bundles

Schematic and Maestro reads are exported from the existing managed Virtuoso process. The package does not reconstruct topology or Maestro setup data as a custom manifest.

- Schematic export saves the complete Cadence Spectre netlist directory, with `input.scs` as the primary artifact.
- Maestro export saves three OCEAN artifact classes: the top-level Assembler script at `maestro/maestro.ocn`, plus `single.ocn` and `sweep.ocn` under every `tests/<index>/` directory. Every discovered test also receives a complete Spectre netlist directory.
- Schematic export accepts `netlist: "none" | "spectre"` and `schematicInstances: "none" | "top-level"`. The defaults preserve the original netlist-only behavior. Selecting `netlist: "none"` and `schematicInstances: "top-level"` writes only `schematic/instances.json`.
- Maestro export accepts `scope: "none" | "all" | "top" | "tests" | "test"`. `all` is the default, while `none` suppresses all OCEAN/netlist artifacts so outputs or placement can be exported independently. `test` requires the exact Maestro `testName`; `scope: "none"` may also use `testName` to select one schematic placement.
- Maestro output export is independently optional through `outputs: "none" | "definitions" | "results" | "all"` (`--outputs` in the CLI). The default is `none`. Definitions are written once to `outputs/definitions/all.csv`; completed values are exported from Cadence's Detail output view once to `outputs/results/<history>/all.csv`. Both aggregate files retain the `Test` column and are not split into per-test CSV files.
- `historyName` (`--history`) is only valid for `results` or `all`. If omitted, the current Maestro history is used, falling back to the latest saved history; export fails explicitly when neither is available.
- `outputTestName` (`--output-test`) filters both definitions and results by the Cadence CSV `Test` column while preserving the canonical aggregate file paths. It requires a non-`none` outputs selection.
- Maestro test schematic placement is independently optional through `schematicInstances: "none" | "top-level"` (`--schematic-instances` in the CLI). `top-level` writes one deduplicated `schematics/all.json` with each unique test design's direct instances, origins, orientations, magnification, and bounding boxes. It records subcircuit instances but never traverses or exports their contents.
- Export never calls `run()` and does not launch a separate `ocean` or `virtuoso` process.
- `bundle.json` only records target identity, test discovery, artifact paths, hashes, provenance, and file-level validation.

Bundles are written under `<project>/.virtuoso-agent/bundles/` by default. Large Cadence files stay on disk; tool results return their paths.
