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
vab modify --plan /path/to/modification-plan.json --validate --json
vab modify --plan /path/to/modification-plan.json --dry-run --json
vab modify --plan /path/to/modification-plan.json --apply --json
vab run --plan /path/to/run.json --json
vab metric extract --plan /path/to/metric-extract.json --json
```

`vab cellview open` is a compatibility alias for `vab cellview show`. Both require an existing managed UI session and never start or close Virtuoso implicitly. If no matching session exists, start one explicitly with `vab session start`.

## Managed Maestro simulation V1

V1 simulation supports only the fixed SKILL/MAE managed-session backend. A run plan explicitly selects either one exact test or all tests currently enabled in the Maestro setup. Test-level runs temporarily change the enabled-test selection and restore it through `unwindProtect`; the temporary selection is never saved.

Before sequence 1, create its run-ready baseline with `virtuoso_export` using `action=maestro`, `scope=all`, `outputs=definitions` (or `all`), and `schematicInstances=top-level`. The bundle target must match the run target. Later sequences reuse the baseline recorded in runtime-owned `workflow.json`.

```json
{
  "schemaVersion": 1,
  "kind": "virtuoso-run-plan",
  "workflow": {
    "id": "ota-optimization",
    "sequence": 1,
    "baselineManifest": "/project/.virtuoso-agent/bundles/baseline/bundle.json"
  },
  "target": {
    "maestro": {
      "library": "test_tb_pi_modify",
      "cell": "two_stage_amp_tb",
      "view": "maestro"
    },
    "selection": {
      "level": "test",
      "testName": "test_tb_two_stage_amp_tb_1"
    }
  },
  "backend": {
    "type": "skill",
    "execution": "managed-session"
  },
  "inactivityTimeoutMs": 1800000
}
```

The runtime monitors long simulations every five seconds. It reads only newly appended bytes from the per-instance Virtuoso stdout/stderr and observes changes to `spectre.out`, `si.foregnd.log`, `exprOutputs.log*`, `.simDone`, `.simExit`, and `logStatus`. Warnings and errors are counted for diagnosis, but log text alone never decides success. If Cadence's blocking wait raises an internal callback error after submission, the runtime keeps the exact history and polls its `axlGetRunStatus` completion count instead of reporting a false simulation failure. Only actual log/result/status progress refreshes the inactivity timer; PID and heartbeat are liveness evidence. An inactivity timeout records `unknown/inactivity-timeout`, does not stop Cadence, and allows the same plan to resume monitoring without another `maeRunSimulation`.

Artifacts are runtime-owned at `.virtuoso-agent/workflows/<workflow-id>/iterations/<sequence>/`. A normal run has `run.json`, `state.json`, `logs/`, and `metrics/`; it does not create a modification plan. Instance stdout/stderr contain only bytes appended during this run, while selected Cadence logs preserve their relative point/test hierarchy. PSF, netlists, and other large result files are not copied.

After the run reaches `run-completed`, extraction uses a separate plan and the exact history stored in `state.json`:

```json
{
  "schemaVersion": 1,
  "kind": "virtuoso-metric-extract-plan",
  "workflow": {
    "id": "ota-optimization",
    "sequence": 1
  },
  "extractor": {
    "type": "mae-output-view"
  }
}
```

V1 extraction supports only `maeExportOutputView` with the Detail view. The runtime owns the output location `metrics/output-view.csv`; the plan cannot provide history, output paths, arbitrary SKILL, retries, polling intervals, or another backend. Canonical schemas are [`schemas/run-plan.schema.json`](schemas/run-plan.schema.json) and [`schemas/metric-extract-plan.schema.json`](schemas/metric-extract-plan.schema.json).

## Cadence-native simulation bundles

Schematic and Maestro reads are exported from the existing managed Virtuoso process. The package does not reconstruct topology or Maestro setup data as a custom manifest.

- Schematic export saves the complete Cadence Spectre netlist directory, with `input.scs` as the primary artifact.
- Maestro export saves three OCEAN artifact classes: the top-level Assembler script at `maestro/maestro.ocn`, plus `single.ocn` and `sweep.ocn` under every enabled `tests/<index>/` directory. Every exported enabled test also receives a complete Spectre netlist directory. Disabled tests remain represented by the top-level Cadence script and are listed in `bundle.json.disabledTests`; the runtime does not misrepresent a script that disables its target as a runnable per-test artifact.
- Schematic export accepts `netlist: "none" | "spectre"` and `schematicInstances: "none" | "top-level"`. The defaults preserve the original netlist-only behavior. Selecting `netlist: "none"` and `schematicInstances: "top-level"` writes only `schematic/instances.json`.
- Maestro export accepts `scope: "none" | "all" | "top" | "tests" | "test"`. `all` is the default, while `none` suppresses all OCEAN/netlist artifacts so outputs or placement can be exported independently. `test` requires the exact Maestro `testName`; `scope: "none"` may also use `testName` to select one schematic placement.
- Maestro output export is independently optional through `outputs: "none" | "definitions" | "results" | "all"` (`--outputs` in the CLI). The default is `none`. Definitions are written once to `outputs/definitions/all.csv`; completed values are exported from Cadence's Detail output view once to `outputs/results/<history>/all.csv`. Both aggregate files retain the `Test` column and are not split into per-test CSV files.
- `historyName` (`--history`) is only valid for `results` or `all`. If omitted, the current Maestro history is used, falling back to the latest saved history; export fails explicitly when neither is available.
- `outputTestName` (`--output-test`) filters both definitions and results by the Cadence CSV `Test` column while preserving the canonical aggregate file paths. It requires a non-`none` outputs selection.
- Maestro test schematic placement is independently optional through `schematicInstances: "none" | "top-level"` (`--schematic-instances` in the CLI). `top-level` writes one deduplicated `schematics/all.json` with each unique test design's direct instances, origins, orientations, magnification, and bounding boxes. It records subcircuit instances but never traverses or exports their contents.
- Export never calls `run()` and does not launch a separate `ocean` or `virtuoso` process.
- `bundle.json` only records target identity, test discovery, artifact paths, hashes, provenance, and file-level validation.

Bundles are written under `<project>/.virtuoso-agent/bundles/` by default. Large Cadence files stay on disk; tool results return their paths.

## Incremental modification plans

`virtuoso_modify` and `vab modify` consume a versioned JSON plan instead of arbitrary SKILL. The runtime currently supports only:

- setting parameters on existing schematic instances through instance CDF data;
- adding or deleting/enabling per-test Maestro analyses;
- adding or deleting per-test Maestro outputs.

It intentionally does not add, delete, place, or wire schematic instances. The canonical schema is [`schemas/modification-plan.schema.json`](schemas/modification-plan.schema.json).

```json
{
  "schemaVersion": 1,
  "kind": "virtuoso-modification-plan",
  "workflow": {
    "id": "ota-optimization",
    "sequence": 1
  },
  "beforeApply": {
    "baselineExport": {
      "policy": "if-missing",
      "profile": "full",
      "onUnavailableResults": "record-and-continue"
    }
  },
  "targets": {
    "schematic": {
      "library": "worklib",
      "cell": "ota_tb",
      "view": "schematic"
    },
    "maestro": {
      "library": "worklib",
      "cell": "ota_tb",
      "view": "maestro"
    }
  },
  "changes": {
    "deviceParameters": [
      {
        "id": "set-c0",
        "operation": "set",
        "instance": "C0",
        "expect": {
          "parameters": {
            "c": "1p"
          }
        },
        "parameters": {
          "c": {
            "value": "2p",
            "valueType": "expression"
          }
        }
      }
    ],
    "tests": [
      {
        "testName": "worklib:ota_tb:1",
        "analyses": [
          {
            "id": "disable-tran",
            "operation": "delete",
            "selector": {
              "name": "tran",
              "type": "tran"
            }
          }
        ],
        "outputs": [
          {
            "id": "add-vout",
            "operation": "add",
            "output": {
              "name": "Vout",
              "type": "expression",
              "expression": "VT(\"/Vout\")",
              "plot": false,
              "save": true
            }
          }
        ]
      }
    ]
  }
}
```

`validate` checks JSON without requiring a live Virtuoso instance. `dry-run` resolves all live instances, parameters, tests, analyses, outputs, and conflicts without saving. `apply` always repeats that preflight in the same managed UI process before saving. Device changes use instance CDF data and invoke the callback attached to each changed parameter so dependent PDK parameters can be updated consistently.

For the first step of a continuous optimization workflow, `baselineExport.policy: "if-missing"` creates a full `virtuoso_export` baseline before modification. Later plans use the same workflow ID, increment `sequence`, include the returned `baselineId`, and set the policy to `reuse`. Runtime-owned `workflow.json`, rather than the Agent-provided sequence alone, decides whether a baseline already exists.

Maestro analysis deletion maps to `maeSetAnalysis(... ?enable nil)`: it disappears from the enabled analysis list and generated OCEAN, although Cadence may retain disabled analysis options for later re-enabling. Output deletion changes the active setup but does not erase values already stored in old simulation histories.

Modification artifacts are written under `<project>/.virtuoso-agent/modifications/<workflow-id>/` by default. Each applied sequence keeps the original plan, resolved plan, controlled generated SKILL, before/after snapshots, and report.
