---
name: virtuoso-agent
description: Use when working with Cadence Virtuoso automation tasks through the virtuoso-agent tools.
---

# Virtuoso Agent

Use high-level `virtuoso_*` tools before raw shell or raw SKILL.

For controlled Virtuoso bridge work, operate only on registered managed instances:

- Use `virtuoso_instances` to list live bridge-managed instances.
- Use `virtuoso_instance_launch` only when a new managed UI instance is explicitly needed.
- Before launching a visible instance, require a real X11 connection. Prefer the `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, and `XDG_RUNTIME_DIR` inherited from the graphical desktop session. Never guess a display from X socket filenames. If the X11 handshake fails, report the error and do not launch Virtuoso.
- Use `virtuoso_inventory` with `action: "libraries"` to discover libraries or `action: "cellviews"` plus `library` to inspect one library. Do not inventory when the user already supplied an exact target.
- Use `virtuoso_export` with `action: "schematic"` or `action: "maestro"` to create a read-only Cadence-native simulation bundle. This exports Spectre/OCEAN files but never runs simulation.
- Use `virtuoso_modify` only after writing a valid `virtuoso-modification-plan` JSON file. It supports existing schematic instance parameters and per-test Maestro analyses/outputs; it does not place devices or edit schematic wiring.
- Use `virtuoso_run` only after writing a valid `virtuoso-run-plan` JSON file. V1 requires the SKILL managed-session backend and an explicit `test` or `maestro` selection. If the user's wording does not distinguish one exact test from all currently enabled tests, ask before writing the plan.
- For workflow sequence 1, first call `virtuoso_export` with `action: "maestro"`, `scope: "all"`, `outputs: "definitions"`, and `schematicInstances: "top-level"`, then put its exact `bundle.json` path in `baselineManifest`. The export target must match the run target. Later sequences reuse the baseline recorded by runtime-owned `workflow.json`; do not export another snapshot merely because an optimization loop reruns.
- Long `virtuoso_run` calls dynamically read newly appended log bytes and Cadence completion markers. Warnings are diagnostic only. If the result is `unknown/inactivity-timeout`, invoke the same run plan again to resume monitoring; never create a second run for that sequence and never kill Virtuoso implicitly.
- Use `virtuoso_metric_extract` only after the iteration's run status is completed. Its plan contains only `schemaVersion`, `kind`, `workflow: {id, sequence}`, and `extractor: {type: "mae-output-view"}`. History, state paths, and `metrics/output-view.csv` are resolved from runtime-owned state and must not be supplied by the Agent.
- If `virtuoso_metric_extract` fails or produces evaluator errors, report that exact-history extraction failed. Do not substitute values from an older history, infer missing metrics from partial simulator logs, or fall back to direct PSF/file extraction in V1.
- Run `virtuoso_modify` with `mode: "validate"` first when constructing a new plan. Use `mode: "dry-run"` to check live object existence and conflicts. Use `mode: "apply"` only when the requested database mutation is authorized.
- For the first mutation in a continuous optimization workflow, set `workflow.sequence` to `1` and `beforeApply.baselineExport.policy` to `"if-missing"` with profile `"full"`. Use the returned baseline ID, increment sequence, and policy `"reuse"` for later mutations in the same workflow.
- Treat `workflow.json` and each step's `report.json` as authoritative. Do not infer that a mutation succeeded merely because generated SKILL exists.
- Use optional `expect` values for device parameters, analysis settings, and deleted output expressions when the current state is known. A conflict must stop the modification; do not silently regenerate the plan around an unexpected value.
- Analysis deletion disables it through the public MAE API. It is absent from enabled analyses and generated OCEAN, but disabled options may remain available for later re-enabling.
- For Maestro, use `scope: "all"` by default, `scope: "top"` for only `maestro/maestro.ocn`, `scope: "tests"` for every enabled test without the top-level script, or `scope: "test"` plus an exact enabled `testName` for one test. Read `bundle.json.disabledTests` for discovered disabled tests; do not treat them as runnable per-test artifacts.
- Treat `bundle.json` as the authoritative artifact index. Read exact paths recorded there; never discover a primary artifact by enumerating bundle files with `find`, `ls`, `head`, globs, or filename guesses.
- For a schematic bundle, read `bundle.json` first and treat its recorded `schematic/netlist/input.scs` as the only primary netlist entry point.
- For a Maestro bundle, read `bundle.json`, then choose among three recorded OCEAN artifact classes: `maestro/maestro.ocn` for the complete top-level setup, the relevant test's `single.ocn` for a nominal single point, or that test's `sweep.ocn` for its sweeps, corners, parameters, specs, and Monte Carlo setup. Read that test's `netlist/input.scs` only when needed.
- Never substitute `ihnl/**`, `ade_e.scs`, `netlistHeader`, `.control`, `amap/**`, or another generated auxiliary file for the primary `input.scs`. If the manifest-recorded path is missing or unreadable, report a bundle integrity error.
- Inspect large artifacts selectively. Use targeted search for the requested design, analysis, parameter, save, output, corner, include, or signal before reading bounded surrounding lines. Never `cat` complete OCEAN scripts or netlists merely to discover what they contain.
- Follow an include referenced by `input.scs` only when the requested fact cannot be established from the primary file, and inspect only the relevant included file.
- For questions about what Maestro testbenches test or measure, derive the answer from enabled tests, analyses, outputs, saves, variables, and corners in the manifest and OCEAN files first. Read `input.scs` only when DUT identity or connectivity remains unresolved.
- Use `virtuoso_cellview` with `action: "show"` when the engineer needs to inspect a cellView in the visible UI, or `action: "current"` to identify the active cellView.

When an operation reports multiple candidates, ask the user to choose and retry that same operation with `instanceId`; a successful operation automatically binds that instance to the pi session. When no instance exists, do not launch one implicitly—ask for authorization first.

For CLI workflows, start Virtuoso explicitly with `vab session start` and reuse it for later commands. `vab cellview open` is a compatibility alias for the managed `vab cellview show`; neither command starts or closes Virtuoso implicitly.

Do not reconstruct schematic topology or Maestro configuration as an ad hoc JSON format. Read state from Cadence-generated export artifacts. The supported operation JSON files are the separately versioned modification, run, and metric-extraction plans.
Do not generate large SKILL scripts as the primary path. Do not use arbitrary SKILL eval for design database operations.
Do not scan, attach to, or claim control over Virtuoso processes that are not present in `virtuoso_instances`.
If an earlier step inspected the wrong artifact, stop and inspect the manifest-recorded artifact before answering; never treat accumulated context cost as a reason to leave a conclusion unverified.
