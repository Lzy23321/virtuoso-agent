import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	enqueueVirtuosoBridgeSessionCommand,
	executeVirtuosoBridgeSessionCommand,
	readVirtuosoBridgeSessionResult,
	skillString,
} from "../backends/virtuoso/bridge.ts";
import {
	type LiveManagedVirtuosoInstance,
	resolveManagedVirtuosoInstance,
} from "../backends/virtuoso/instance-registry.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import type { ManagedVirtuosoRequest } from "./managed-virtuoso.ts";

export interface VirtuosoRunPlan {
	schemaVersion: 1;
	kind: "virtuoso-run-plan";
	workflow: {
		id: string;
		sequence: number;
		baselineManifest?: string;
	};
	target: {
		maestro: { library: string; cell: string; view: string };
		selection: { level: "test"; testName: string } | { level: "maestro" };
	};
	backend: { type: "skill"; execution: "managed-session" };
	inactivityTimeoutMs?: number;
}

export interface VirtuosoMetricExtractPlan {
	schemaVersion: 1;
	kind: "virtuoso-metric-extract-plan";
	workflow: { id: string; sequence: number };
	extractor: { type: "mae-output-view" };
}

export type SimulationRunStatus =
	| "prepared"
	| "running"
	| "run-completed"
	| "extracting"
	| "completed"
	| "failed"
	| "unknown";

export interface SimulationLogArtifact {
	path: string;
	bytes: number;
	updatedAt: string;
	warnings: number;
	errors: number;
	fatals: number;
}

export interface SimulationIterationState {
	schemaVersion: 1;
	workflowId: string;
	sequence: number;
	planHash: string;
	status: SimulationRunStatus;
	run: {
		status: "prepared" | "running" | "completed" | "failed" | "unknown";
		instanceId: string;
		pid?: number;
		startedAt: string;
		updatedAt: string;
		completedAt?: string;
		historyName?: string;
		resultsRoot?: string;
		commandPath?: string;
		resultPath?: string;
		progressPath?: string;
		stdoutStartOffset: number;
		stderrStartOffset: number;
		reason?: "instance-lost" | "inactivity-timeout" | "bridge-error";
	};
	extraction: {
		status: "not-started" | "extracting" | "completed" | "failed";
		csvPath?: string;
		rows?: number;
	};
	logs: {
		monitor: string;
		artifacts: SimulationLogArtifact[];
		warnings: number;
		errors: number;
		fatals: number;
	};
}

export interface RunManagedSimulationRequest extends ManagedVirtuosoRequest {
	planPath: string;
	monitorPollIntervalMs?: number;
}

export interface ExtractManagedSimulationMetricsRequest extends ManagedVirtuosoRequest {
	planPath: string;
}

export interface SimulationRunResult {
	instance: LiveManagedVirtuosoInstance;
	plan: VirtuosoRunPlan;
	iterationDirectory: string;
	statePath: string;
	state: SimulationIterationState;
}

export interface SimulationMetricExtractResult {
	instance: LiveManagedVirtuosoInstance;
	plan: VirtuosoMetricExtractPlan;
	iterationDirectory: string;
	statePath: string;
	csvPath: string;
	rows: number;
	state: SimulationIterationState;
}

interface SimulationSkillProgress {
	historyName: string;
	resultsRoot: string;
}

interface SimulationSkillResult extends SimulationSkillProgress {
	waitCompleted: boolean;
}

interface SimulationSkillStatus {
	historyName: string;
	completed: number;
	total: number;
}

interface WorkflowRecord {
	schemaVersion: 1;
	id: string;
	baselineManifest: string;
	target: VirtuosoRunPlan["target"]["maestro"];
	lastSequence: number;
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 1_800_000;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5_000;
const MONITORED_NAMES = new Set(["spectre.out", "si.foregnd.log", ".simDone", ".simExit", "logStatus"]);
const SKIPPED_RESULT_DIRECTORIES = new Set(["psf", "netlist", "ihnl", "amap"]);
const METRIC_PLAN_SHAPE =
	'{"schemaVersion":1,"kind":"virtuoso-metric-extract-plan","workflow":{"id":"<workflow-id>","sequence":1},"extractor":{"type":"mae-output-view"}}';
const METRIC_PLAN_HINT = `Expected shape: ${METRIC_PLAN_SHAPE} State paths, history names, and CSV paths are runtime-owned.`;

export async function loadVirtuosoRunPlan(path: string): Promise<RuntimeResult<VirtuosoRunPlan>> {
	return loadAndValidate(path, validateVirtuosoRunPlan, "run_plan_read_error", "run_plan_read");
}

export async function loadVirtuosoMetricExtractPlan(path: string): Promise<RuntimeResult<VirtuosoMetricExtractPlan>> {
	return loadAndValidate(
		path,
		validateVirtuosoMetricExtractPlan,
		"metric_extract_plan_read_error",
		"metric_extract_plan_read",
	);
}

export function validateVirtuosoRunPlan(value: unknown): RuntimeResult<VirtuosoRunPlan> {
	const issues: string[] = [];
	if (!isRecord(value)) {
		return invalid("run_plan_invalid", "run_plan_validation", ["plan must be a JSON object"]);
	}
	rejectUnknown(
		value,
		["schemaVersion", "kind", "workflow", "target", "backend", "inactivityTimeoutMs"],
		"plan",
		issues,
	);
	if (value.schemaVersion !== 1) issues.push("schemaVersion must be 1");
	if (value.kind !== "virtuoso-run-plan") issues.push('kind must be "virtuoso-run-plan"');

	const workflow = value.workflow;
	if (!isRecord(workflow)) {
		issues.push("workflow must be an object");
	} else {
		rejectUnknown(workflow, ["id", "sequence", "baselineManifest"], "workflow", issues);
		if (typeof workflow.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workflow.id)) {
			issues.push("workflow.id must be a safe 1-128 character identifier");
		}
		if (!Number.isInteger(workflow.sequence) || Number(workflow.sequence) < 1) {
			issues.push("workflow.sequence must be an integer >= 1");
		}
		if (workflow.sequence === 1 && typeof workflow.baselineManifest !== "string") {
			issues.push("workflow.baselineManifest is required when sequence is 1");
		}
		if (workflow.baselineManifest !== undefined && typeof workflow.baselineManifest !== "string") {
			issues.push("workflow.baselineManifest must be a path string");
		}
	}

	const target = value.target;
	if (!isRecord(target)) {
		issues.push("target must be an object");
	} else {
		rejectUnknown(target, ["maestro", "selection"], "target", issues);
		validateCellView(target.maestro, "target.maestro", issues);
		const selection = target.selection;
		if (!isRecord(selection)) {
			issues.push("target.selection must be an object");
		} else if (selection.level === "test") {
			rejectUnknown(selection, ["level", "testName"], "target.selection", issues);
			if (typeof selection.testName !== "string" || selection.testName.length === 0) {
				issues.push("target.selection.testName is required for test runs");
			}
		} else if (selection.level === "maestro") {
			rejectUnknown(selection, ["level"], "target.selection", issues);
		} else {
			issues.push('target.selection.level must be "test" or "maestro"');
		}
	}

	const backend = value.backend;
	if (!isRecord(backend)) {
		issues.push("backend must be an object");
	} else {
		rejectUnknown(backend, ["type", "execution"], "backend", issues);
		if (backend.type !== "skill") issues.push('backend.type must be "skill"');
		if (backend.execution !== "managed-session") {
			issues.push('backend.execution must be "managed-session"');
		}
	}
	if (
		value.inactivityTimeoutMs !== undefined &&
		(!Number.isInteger(value.inactivityTimeoutMs) || Number(value.inactivityTimeoutMs) < 1_000)
	) {
		issues.push("inactivityTimeoutMs must be an integer >= 1000");
	}
	return issues.length > 0
		? invalid("run_plan_invalid", "run_plan_validation", issues)
		: ok(value as unknown as VirtuosoRunPlan);
}

export function validateVirtuosoMetricExtractPlan(value: unknown): RuntimeResult<VirtuosoMetricExtractPlan> {
	const issues: string[] = [];
	if (!isRecord(value)) {
		return invalid(
			"metric_extract_plan_invalid",
			"metric_extract_plan_validation",
			["plan must be a JSON object"],
			METRIC_PLAN_HINT,
		);
	}
	rejectUnknown(value, ["schemaVersion", "kind", "workflow", "extractor"], "plan", issues);
	if (value.schemaVersion !== 1) issues.push("schemaVersion must be 1");
	if (value.kind !== "virtuoso-metric-extract-plan") {
		issues.push('kind must be "virtuoso-metric-extract-plan"');
	}
	if (!isRecord(value.workflow)) {
		issues.push("workflow must be an object");
	} else {
		rejectUnknown(value.workflow, ["id", "sequence"], "workflow", issues);
		if (typeof value.workflow.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.workflow.id)) {
			issues.push("workflow.id must be a safe 1-128 character identifier");
		}
		if (!Number.isInteger(value.workflow.sequence) || Number(value.workflow.sequence) < 1) {
			issues.push("workflow.sequence must be an integer >= 1");
		}
	}
	if (!isRecord(value.extractor)) {
		issues.push("extractor must be an object");
	} else {
		rejectUnknown(value.extractor, ["type"], "extractor", issues);
		if (value.extractor.type !== "mae-output-view") {
			issues.push('extractor.type must be "mae-output-view"');
		}
	}
	return issues.length > 0
		? invalid("metric_extract_plan_invalid", "metric_extract_plan_validation", issues, METRIC_PLAN_HINT)
		: ok(value as unknown as VirtuosoMetricExtractPlan);
}

export async function runManagedVirtuosoSimulation(
	request: RunManagedSimulationRequest,
): Promise<RuntimeResult<SimulationRunResult>> {
	const loaded = await loadVirtuosoRunPlan(request.planPath);
	if (!loaded.ok) return loaded;
	const plan = loaded.value;
	const instance = await resolveManagedVirtuosoInstance({
		registryDir: request.registryDir,
		instanceId: request.instanceId,
		cdsLib: request.cdsLib,
		requireUi: true,
		heartbeatTimeoutMs: Number.MAX_SAFE_INTEGER,
	});
	if (!instance.ok) return instance;

	const prepared = await prepareIteration(instance.value, plan, request.planPath);
	if (!prepared.ok) return prepared;
	let state = prepared.value.state;
	if (state.run.instanceId !== instance.value.instanceId) {
		return fail({
			type: "simulation_run_instance_mismatch",
			stage: "simulation_run_prepare",
			message: `This iteration belongs to managed instance ${state.run.instanceId}.`,
			details: { requestedInstanceId: instance.value.instanceId, statePath: prepared.value.paths.statePath },
		});
	}
	if (state.status === "completed" || state.status === "run-completed") {
		return ok({ instance: instance.value, plan, ...prepared.value.paths, state });
	}
	if (state.status === "failed") {
		return fail({
			type: "simulation_run_failed_is_immutable",
			stage: "simulation_run_prepare",
			message: "This sequence already failed. Use the next workflow sequence for a new simulation.",
			details: { statePath: prepared.value.paths.statePath },
		});
	}
	if (state.status === "prepared") {
		const queued = await queueSimulation(instance.value, plan, state, prepared.value.paths);
		if (!queued.ok) return queued;
		state = queued.value;
	}
	const monitored = await monitorSimulation(
		instance.value,
		plan,
		state,
		prepared.value.paths,
		request.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS,
	);
	if (!monitored.ok) return monitored;
	return ok({ instance: instance.value, plan, ...prepared.value.paths, state: monitored.value });
}

export async function extractManagedVirtuosoMetrics(
	request: ExtractManagedSimulationMetricsRequest,
): Promise<RuntimeResult<SimulationMetricExtractResult>> {
	const loaded = await loadVirtuosoMetricExtractPlan(request.planPath);
	if (!loaded.ok) return loaded;
	const plan = loaded.value;
	const instance = await resolveManagedVirtuosoInstance({
		registryDir: request.registryDir,
		instanceId: request.instanceId,
		cdsLib: request.cdsLib,
		requireUi: true,
		heartbeatTimeoutMs: Number.MAX_SAFE_INTEGER,
	});
	if (!instance.ok) return instance;
	const iterationDirectory = iterationPath(instance.value.cwd, plan.workflow.id, plan.workflow.sequence);
	const statePath = join(iterationDirectory, "state.json");
	const stateResult = await readState(statePath);
	if (!stateResult.ok) return stateResult;
	let state = stateResult.value;
	if (state.workflowId !== plan.workflow.id || state.sequence !== plan.workflow.sequence) {
		return fail({
			type: "metric_extract_iteration_mismatch",
			stage: "metric_extract_prepare",
			message: "Metric plan does not match the iteration state.",
			details: { statePath },
		});
	}
	if (state.status === "completed" && state.extraction.csvPath) {
		return ok({
			instance: instance.value,
			plan,
			iterationDirectory,
			statePath,
			csvPath: resolve(iterationDirectory, state.extraction.csvPath),
			rows: state.extraction.rows ?? 0,
			state,
		});
	}
	if (state.run.status !== "completed" || !state.run.historyName) {
		return fail({
			type: "metric_extract_run_not_completed",
			stage: "metric_extract_prepare",
			message: "Metric extraction requires a completed simulation with an exact history.",
			details: { statePath, runStatus: state.run.status },
		});
	}
	const metricsDirectory = join(iterationDirectory, "metrics");
	const csvPath = join(metricsDirectory, "output-view.csv");
	const temporaryCsvPath = join(metricsDirectory, ".output-view.tmp.csv");
	await mkdir(metricsDirectory, { recursive: true });
	await atomicWrite(join(iterationDirectory, "metric-extract.json"), `${JSON.stringify(plan, null, 2)}\n`);
	state = {
		...state,
		status: "extracting",
		extraction: { status: "extracting" },
	};
	await writeState(statePath, state);
	const skillPath = getMetricExtractSkillPath();
	const target = await readRunPlanFromIteration(iterationDirectory);
	if (!target.ok) return target;
	const maestro = target.value.target.maestro;
	const result = await executeVirtuosoBridgeSessionCommand<{ csvPath: string; historyName: string }>({
		sessionDir: instance.value.sessionDir,
		heartbeatPath: instance.value.heartbeatPath,
		timeoutMs: request.timeoutMs ?? 120_000,
		expression: (resultPath) =>
			`load(${skillString(skillPath)})\nvaMetricExtractMaeOutputViewV1(${skillString(maestro.library)} ${skillString(
				maestro.cell,
			)} ${skillString(maestro.view)} ${skillString(state.run.historyName ?? "")} ${skillString(
				temporaryCsvPath,
			)} ${skillString(resultPath)})`,
	});
	if (!result.ok) {
		state = { ...state, status: "run-completed", extraction: { status: "failed" } };
		await writeState(statePath, state);
		return result;
	}
	let csv: string;
	try {
		csv = await readFile(temporaryCsvPath, "utf8");
	} catch (error) {
		state = { ...state, status: "run-completed", extraction: { status: "failed" } };
		await writeState(statePath, state);
		return ioFailure("metric_extract_csv_read_error", "metric_extract_validate", temporaryCsvPath, error);
	}
	const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const detailHeaderIndex = lines.findIndex((line) => {
		const columns = line.split(",").map((column) => column.trim().replace(/^"|"$/g, ""));
		return columns.includes("Test") && columns.includes("Output");
	});
	if (detailHeaderIndex < 0) {
		state = { ...state, status: "run-completed", extraction: { status: "failed" } };
		await writeState(statePath, state);
		return fail({
			type: "metric_extract_csv_invalid",
			stage: "metric_extract_validate",
			message: "maeExportOutputView did not produce a non-empty Detail CSV.",
			details: { temporaryCsvPath },
		});
	}
	const detailColumns = lines[detailHeaderIndex].split(",").map((column) => column.trim().replace(/^"|"$/g, ""));
	const nominalIndex = detailColumns.indexOf("Nominal");
	const detailRows = lines.slice(detailHeaderIndex + 1);
	if (
		nominalIndex >= 0 &&
		detailRows.length > 0 &&
		detailRows.every((line) => /\beval err\b/i.test(line.split(",")[nominalIndex] ?? ""))
	) {
		state = { ...state, status: "run-completed", extraction: { status: "failed" } };
		await writeState(statePath, state);
		return fail({
			type: "metric_extract_all_values_error",
			stage: "metric_extract_validate",
			message: "The Detail CSV was created, but every nominal output value is an evaluator error.",
			details: { temporaryCsvPath, historyName: state.run.historyName },
		});
	}
	await rename(temporaryCsvPath, csvPath);
	const rows = detailRows.length;
	state = {
		...state,
		status: "completed",
		extraction: {
			status: "completed",
			csvPath: relative(iterationDirectory, csvPath),
			rows,
		},
	};
	await writeState(statePath, state);
	return ok({
		instance: instance.value,
		plan,
		iterationDirectory,
		statePath,
		csvPath,
		rows,
		state,
	});
}

async function prepareIteration(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoRunPlan,
	planPath: string,
): Promise<
	RuntimeResult<{
		paths: { iterationDirectory: string; statePath: string };
		state: SimulationIterationState;
	}>
> {
	const workflowDirectory = join(instance.cwd, ".virtuoso-agent", "workflows", plan.workflow.id);
	const iterationDirectory = iterationPath(instance.cwd, plan.workflow.id, plan.workflow.sequence);
	const statePath = join(iterationDirectory, "state.json");
	const existing = await readOptionalState(statePath);
	const planHash = hashJson(plan);
	if (existing) {
		if (existing.planHash !== planHash) {
			return fail({
				type: "simulation_run_plan_conflict",
				stage: "simulation_run_prepare",
				message: "The iteration already exists with a different run plan.",
				details: { statePath },
			});
		}
		return ok({ paths: { iterationDirectory, statePath }, state: existing });
	}

	let workflow = await readOptionalWorkflow(join(workflowDirectory, "workflow.json"));
	if (plan.workflow.sequence === 1) {
		const baseline = resolve(dirname(resolve(planPath)), plan.workflow.baselineManifest ?? "");
		const validated = await validateBaseline(baseline, plan);
		if (!validated.ok) return validated;
		workflow = {
			schemaVersion: 1,
			id: plan.workflow.id,
			baselineManifest: baseline,
			target: plan.target.maestro,
			lastSequence: 0,
		};
	} else if (!workflow) {
		return fail({
			type: "simulation_workflow_not_found",
			stage: "simulation_run_prepare",
			message: "A later sequence requires an existing workflow.json from sequence 1.",
			details: { workflowDirectory },
		});
	}
	if (
		!workflow ||
		workflow.id !== plan.workflow.id ||
		JSON.stringify(workflow.target) !== JSON.stringify(plan.target.maestro)
	) {
		return fail({
			type: "simulation_workflow_target_conflict",
			stage: "simulation_run_prepare",
			message: "Run target does not match the existing workflow.",
			details: { workflowDirectory },
		});
	}
	if (plan.workflow.sequence !== workflow.lastSequence + 1) {
		return fail({
			type: "simulation_workflow_sequence_invalid",
			stage: "simulation_run_prepare",
			message: `Expected workflow sequence ${workflow.lastSequence + 1}.`,
			details: { requested: plan.workflow.sequence },
		});
	}
	await mkdir(join(iterationDirectory, "logs", "cadence"), { recursive: true });
	await mkdir(join(iterationDirectory, "metrics"), { recursive: true });
	await atomicWrite(join(iterationDirectory, "run.json"), `${JSON.stringify(plan, null, 2)}\n`);
	const instanceStdout = join(instance.sessionDir, "logs", "virtuoso.stdout.log");
	const instanceStderr = join(instance.sessionDir, "logs", "virtuoso.stderr.log");
	const now = new Date().toISOString();
	const state: SimulationIterationState = {
		schemaVersion: 1,
		workflowId: plan.workflow.id,
		sequence: plan.workflow.sequence,
		planHash,
		status: "prepared",
		run: {
			status: "prepared",
			instanceId: instance.instanceId,
			pid: instance.pid,
			startedAt: now,
			updatedAt: now,
			stdoutStartOffset: await fileSize(instanceStdout),
			stderrStartOffset: await fileSize(instanceStderr),
		},
		extraction: { status: "not-started" },
		logs: {
			monitor: "logs/monitor.log",
			artifacts: [],
			warnings: 0,
			errors: 0,
			fatals: 0,
		},
	};
	await writeState(statePath, state);
	await atomicWrite(join(workflowDirectory, "workflow.json"), `${JSON.stringify(workflow, null, 2)}\n`);
	return ok({ paths: { iterationDirectory, statePath }, state });
}

async function queueSimulation(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoRunPlan,
	state: SimulationIterationState,
	paths: { iterationDirectory: string; statePath: string },
): Promise<RuntimeResult<SimulationIterationState>> {
	const resultFileName = `simulation-${safeName(plan.workflow.id)}-${String(plan.workflow.sequence).padStart(6, "0")}.json`;
	const progressPath = join(instance.resultDir, resultFileName.replace(/\.json$/, ".progress.json"));
	const target = plan.target.maestro;
	const selection = plan.target.selection;
	const skillPath = getSimulationRunSkillPath();
	const queued = await enqueueVirtuosoBridgeSessionCommand({
		sessionDir: instance.sessionDir,
		resultFileName,
		expression: [
			`load(${skillString(skillPath)})`,
			`vaSimulationRunV1(${skillString(target.library)} ${skillString(target.cell)} ${skillString(
				target.view,
			)} ${skillString(selection.level)} ${skillString(
				selection.level === "test" ? selection.testName : "",
			)} ${skillString(progressPath)} ${skillString(join(instance.resultDir, resultFileName))})`,
		].join("\n"),
	});
	if (!queued.ok) return queued;
	const next: SimulationIterationState = {
		...state,
		status: "running",
		run: {
			...state.run,
			status: "running",
			commandPath: queued.value.commandPath,
			resultPath: queued.value.resultPath,
			progressPath,
			updatedAt: new Date().toISOString(),
		},
	};
	await writeState(paths.statePath, next);
	await appendMonitor(paths.iterationDirectory, "run-queued");
	return ok(next);
}

async function monitorSimulation(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoRunPlan,
	initialState: SimulationIterationState,
	paths: { iterationDirectory: string; statePath: string },
	pollIntervalMs: number,
): Promise<RuntimeResult<SimulationIterationState>> {
	let state = initialState;
	let lastProgressAt = Date.now();
	const observed = new Map<string, { size: number; mtimeMs: number }>();
	const instanceStdout = join(instance.sessionDir, "logs", "virtuoso.stdout.log");
	const instanceStderr = join(instance.sessionDir, "logs", "virtuoso.stderr.log");
	observed.set(instanceStdout, { size: state.run.stdoutStartOffset, mtimeMs: 0 });
	observed.set(instanceStderr, { size: state.run.stderrStartOffset, mtimeMs: 0 });
	let lastHistory = state.run.historyName;
	let lastCompletedPoints: number | undefined;
	let waitFallbackLogged = false;
	for (;;) {
		let progressed = false;
		if (state.run.progressPath) {
			const progress = await readVirtuosoBridgeSessionResult<SimulationSkillProgress>(state.run.progressPath);
			if (progress?.ok && progress.value.historyName !== lastHistory) {
				lastHistory = progress.value.historyName;
				state = {
					...state,
					run: {
						...state.run,
						historyName: progress.value.historyName,
						resultsRoot: progress.value.resultsRoot,
						updatedAt: new Date().toISOString(),
					},
				};
				await appendMonitor(paths.iterationDirectory, `history-created ${progress.value.historyName}`);
				progressed = true;
			}
		}
		const watched = state.run.resultsRoot
			? [instanceStdout, instanceStderr, ...(await discoverMonitoredFiles(state.run.resultsRoot))]
			: [instanceStdout, instanceStderr];
		for (const path of watched) {
			let info: Stats;
			try {
				info = await stat(path);
			} catch {
				continue;
			}
			const previous = observed.get(path);
			if (!previous || info.size !== previous.size || info.mtimeMs !== previous.mtimeMs) {
				const start = previous && info.size >= previous.size ? previous.size : 0;
				const added = await readTextSlice(path, start);
				const warnings = matchCount(added, /\bwarn(?:ing)?\b/gi);
				const errors = matchCount(added, /\berror\b/gi);
				const fatals = matchCount(added, /\b(?:fatal|segmentation fault|panic)\b/gi);
				observed.set(path, { size: info.size, mtimeMs: info.mtimeMs });
				state = {
					...state,
					logs: {
						...state.logs,
						warnings: state.logs.warnings + warnings,
						errors: state.logs.errors + errors,
						fatals: state.logs.fatals + fatals,
					},
				};
				const relativeResultPath = state.run.resultsRoot ? relative(state.run.resultsRoot, path) : undefined;
				const displayPath =
					relativeResultPath && !relativeResultPath.startsWith("..") ? relativeResultPath : basename(path);
				await appendMonitor(
					paths.iterationDirectory,
					`${monitorEventName(path)} ${displayPath} bytes=${info.size} warnings=${warnings} errors=${errors} fatals=${fatals}`,
				);
				progressed = true;
			}
		}
		if (state.run.resultPath) {
			const result = await readVirtuosoBridgeSessionResult<SimulationSkillResult>(state.run.resultPath);
			if (result !== undefined) {
				if (!result.ok) {
					state = {
						...state,
						status: "failed",
						run: {
							...state.run,
							status: "failed",
							reason: "bridge-error",
							updatedAt: new Date().toISOString(),
						},
					};
					await archiveLogs(instance, paths.iterationDirectory, state);
					await writeState(paths.statePath, state);
					return result;
				}
				if (result.value.waitCompleted) {
					return completeSimulation(
						instance,
						plan,
						state,
						paths,
						result.value.historyName,
						result.value.resultsRoot,
					);
				}
				if (!waitFallbackLogged) {
					await appendMonitor(paths.iterationDirectory, "mae-wait-fallback");
					waitFallbackLogged = true;
				}
				const runStatus = await querySimulationStatus(instance, plan, result.value.historyName);
				if (runStatus.ok) {
					const { completed, total } = runStatus.value;
					if (completed !== lastCompletedPoints) {
						await appendMonitor(paths.iterationDirectory, `mae-run-status completed=${completed} total=${total}`);
						lastCompletedPoints = completed;
						progressed = true;
					}
					if (total > 0 && completed >= total) {
						return completeSimulation(
							instance,
							plan,
							state,
							paths,
							result.value.historyName,
							result.value.resultsRoot,
						);
					}
				}
			}
		}
		if (instance.pid !== undefined && !isProcessAlive(instance.pid)) {
			state = {
				...state,
				status: "failed",
				run: {
					...state.run,
					status: "failed",
					reason: "instance-lost",
					updatedAt: new Date().toISOString(),
				},
			};
			await appendMonitor(paths.iterationDirectory, "instance-lost");
			state = await archiveLogs(instance, paths.iterationDirectory, state);
			await writeState(paths.statePath, state);
			return ok(state);
		}
		if (progressed) {
			lastProgressAt = Date.now();
			state = { ...state, run: { ...state.run, updatedAt: new Date().toISOString() } };
			await writeState(paths.statePath, state);
		}
		const inactivityTimeoutMs = plan.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
		if (Date.now() - lastProgressAt >= inactivityTimeoutMs) {
			const result = state.run.resultPath
				? await readVirtuosoBridgeSessionResult<SimulationSkillResult>(state.run.resultPath)
				: undefined;
			if (result?.ok) continue;
			const processAlive = instance.pid === undefined || isProcessAlive(instance.pid);
			const heartbeatAge = await fileAgeMs(instance.heartbeatPath);
			await appendMonitor(
				paths.iterationDirectory,
				`liveness pid=${processAlive ? "alive" : "lost"} heartbeatAgeMs=${heartbeatAge ?? "missing"}`,
			);
			state = {
				...state,
				status: processAlive ? "unknown" : "failed",
				run: {
					...state.run,
					status: processAlive ? "unknown" : "failed",
					reason: processAlive ? "inactivity-timeout" : "instance-lost",
					updatedAt: new Date().toISOString(),
				},
			};
			await appendMonitor(paths.iterationDirectory, processAlive ? "inactivity-timeout" : "instance-lost");
			state = await archiveLogs(instance, paths.iterationDirectory, state);
			await writeState(paths.statePath, state);
			return ok(state);
		}
		await delay(pollIntervalMs);
	}
}

async function querySimulationStatus(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoRunPlan,
	historyName: string,
): Promise<RuntimeResult<SimulationSkillStatus>> {
	const target = plan.target.maestro;
	const skillPath = getSimulationRunSkillPath();
	const queried = await executeVirtuosoBridgeSessionCommand<SimulationSkillStatus>({
		sessionDir: instance.sessionDir,
		heartbeatPath: instance.heartbeatPath,
		expression: (resultPath) =>
			[
				`load(${skillString(skillPath)})`,
				`vaSimulationRunStatusV1(${skillString(target.library)} ${skillString(target.cell)} ${skillString(
					target.view,
				)} ${skillString(historyName)} ${skillString(resultPath)})`,
			].join("\n"),
		timeoutMs: 30_000,
	});
	return queried.ok ? ok(queried.value.value) : queried;
}

async function completeSimulation(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoRunPlan,
	state: SimulationIterationState,
	paths: { iterationDirectory: string; statePath: string },
	historyName: string,
	resultsRoot: string,
): Promise<RuntimeResult<SimulationIterationState>> {
	let completedState: SimulationIterationState = {
		...state,
		status: "run-completed",
		run: {
			...state.run,
			status: "completed",
			historyName,
			resultsRoot,
			completedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	};
	await appendMonitor(paths.iterationDirectory, "mae-run-completed");
	completedState = await archiveLogs(instance, paths.iterationDirectory, completedState);
	await writeState(paths.statePath, completedState);
	await completeWorkflow(instance.cwd, plan);
	return ok(completedState);
}

async function archiveLogs(
	instance: LiveManagedVirtuosoInstance,
	iterationDirectory: string,
	state: SimulationIterationState,
): Promise<SimulationIterationState> {
	const artifacts: SimulationLogArtifact[] = [];
	const stdoutSource = join(instance.sessionDir, "logs", "virtuoso.stdout.log");
	const stderrSource = join(instance.sessionDir, "logs", "virtuoso.stderr.log");
	for (const item of [
		{
			source: stdoutSource,
			start: state.run.stdoutStartOffset,
			target: join(iterationDirectory, "logs", "virtuoso.stdout.log"),
		},
		{
			source: stderrSource,
			start: state.run.stderrStartOffset,
			target: join(iterationDirectory, "logs", "virtuoso.stderr.log"),
		},
	]) {
		const copied = await copySliceAtomically(item.source, item.target, item.start);
		if (copied) artifacts.push(await describeLog(iterationDirectory, item.target));
	}
	if (state.run.resultsRoot) {
		for (const source of await discoverMonitoredFiles(state.run.resultsRoot)) {
			if (!isArchivableLog(source)) continue;
			const relativePath = relative(state.run.resultsRoot, source);
			const target = join(iterationDirectory, "logs", "cadence", relativePath);
			await copyAtomically(source, target);
			artifacts.push(await describeLog(iterationDirectory, target));
		}
	}
	const totals = artifacts.reduce(
		(sum, log) => ({
			warnings: sum.warnings + log.warnings,
			errors: sum.errors + log.errors,
			fatals: sum.fatals + log.fatals,
		}),
		{ warnings: 0, errors: 0, fatals: 0 },
	);
	return { ...state, logs: { ...state.logs, artifacts, ...totals } };
}

async function discoverMonitoredFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory() && !SKIPPED_RESULT_DIRECTORIES.has(entry.name)) pending.push(path);
			else if (MONITORED_NAMES.has(entry.name) || entry.name.startsWith("exprOutputs.log")) found.push(path);
		}
	}
	return found.sort();
}

async function describeLog(root: string, path: string): Promise<SimulationLogArtifact> {
	const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
	return {
		path: relative(root, path),
		bytes: info.size,
		updatedAt: info.mtime.toISOString(),
		warnings: matchCount(text, /\bwarn(?:ing)?\b/gi),
		errors: matchCount(text, /\berror\b/gi),
		fatals: matchCount(text, /\b(?:fatal|segmentation fault|panic)\b/gi),
	};
}

async function validateBaseline(path: string, plan: VirtuosoRunPlan): Promise<RuntimeResult<void>> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		return ioFailure("simulation_baseline_read_error", "simulation_run_prepare", path, error);
	}
	if (!isRecord(value) || value.kind !== "maestro-simulation-bundle" || !isRecord(value.target)) {
		return fail({
			type: "simulation_baseline_invalid",
			stage: "simulation_run_prepare",
			message: "baselineManifest must reference a Maestro simulation bundle.",
			details: { path },
		});
	}
	const target = value.target;
	const expected = plan.target.maestro;
	if (target.library !== expected.library || target.cell !== expected.cell || target.view !== expected.view) {
		return fail({
			type: "simulation_baseline_target_mismatch",
			stage: "simulation_run_prepare",
			message: "Baseline Maestro target does not match the run target.",
			details: { path, expected, actual: target },
		});
	}
	const actual = {
		scope: value.scope ?? null,
		outputs: isRecord(value.outputs) ? (value.outputs.mode ?? null) : null,
		schematicInstances: isRecord(value.schematicInstances) ? (value.schematicInstances.mode ?? null) : null,
	};
	const missing: string[] = [];
	if (actual.scope !== "all") missing.push("scope=all");
	if (actual.outputs !== "all" && actual.outputs !== "definitions") {
		missing.push("outputs=definitions|all");
	}
	if (actual.schematicInstances !== "top-level") {
		missing.push("schematicInstances=top-level");
	}
	if (missing.length > 0) {
		const requiredExport = {
			action: "maestro",
			scope: "all",
			outputs: "definitions",
			schematicInstances: "top-level",
		};
		return fail({
			type: "simulation_baseline_not_full",
			stage: "simulation_run_prepare",
			message: `Sequence 1 baseline is not run-ready. Missing: ${missing.join(", ")}. Create it with virtuoso_export using action=maestro, scope=all, outputs=definitions, and schematicInstances=top-level.`,
			details: { path, actual, missing, requiredExport },
		});
	}
	return ok(undefined);
}

async function completeWorkflow(cwd: string, plan: VirtuosoRunPlan): Promise<void> {
	const path = join(cwd, ".virtuoso-agent", "workflows", plan.workflow.id, "workflow.json");
	const workflow = await readOptionalWorkflow(path);
	if (workflow)
		await atomicWrite(path, `${JSON.stringify({ ...workflow, lastSequence: plan.workflow.sequence }, null, 2)}\n`);
}

async function readRunPlanFromIteration(iterationDirectory: string): Promise<RuntimeResult<VirtuosoRunPlan>> {
	return loadVirtuosoRunPlan(join(iterationDirectory, "run.json"));
}

async function readState(path: string): Promise<RuntimeResult<SimulationIterationState>> {
	const state = await readOptionalState(path);
	return state
		? ok(state)
		: fail({
				type: "simulation_iteration_not_found",
				stage: "simulation_state_read",
				message: "Simulation iteration state.json was not found.",
				details: { path },
			});
}

async function readOptionalState(path: string): Promise<SimulationIterationState | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as SimulationIterationState;
	} catch {
		return undefined;
	}
}

async function readOptionalWorkflow(path: string): Promise<WorkflowRecord | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as WorkflowRecord;
	} catch {
		return undefined;
	}
}

async function writeState(path: string, state: SimulationIterationState): Promise<void> {
	await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function atomicWrite(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp`;
	await writeFile(temporaryPath, value, "utf8");
	await rename(temporaryPath, path);
}

async function appendMonitor(iterationDirectory: string, message: string): Promise<void> {
	const path = join(iterationDirectory, "logs", "monitor.log");
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "a");
	try {
		await handle.write(`${new Date().toISOString()} ${message}\n`);
	} finally {
		await handle.close();
	}
}

async function copyAtomically(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const temporaryPath = `${target}.tmp`;
	await copyFile(source, temporaryPath);
	await rename(temporaryPath, target);
}

async function copySliceAtomically(source: string, target: string, start: number): Promise<boolean> {
	let data: Buffer;
	try {
		const handle = await open(source, "r");
		try {
			const info = await handle.stat();
			const length = Math.max(0, info.size - start);
			data = Buffer.alloc(length);
			if (length > 0) await handle.read(data, 0, length, start);
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
	await mkdir(dirname(target), { recursive: true });
	const temporaryPath = `${target}.tmp`;
	await writeFile(temporaryPath, data);
	await rename(temporaryPath, target);
	return true;
}

async function readTextSlice(path: string, start: number): Promise<string> {
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			const length = Math.max(0, info.size - start);
			if (length === 0) return "";
			const data = Buffer.alloc(length);
			await handle.read(data, 0, length, start);
			return data.toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

function validateCellView(value: unknown, path: string, issues: string[]): void {
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}
	rejectUnknown(value, ["library", "cell", "view"], path, issues);
	for (const key of ["library", "cell", "view"]) {
		if (typeof value[key] !== "string" || value[key].length === 0) issues.push(`${path}.${key} is required`);
	}
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], path: string, issues: string[]): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is not allowed`);
}

function invalid<T>(type: string, stage: string, issues: string[], hint?: string): RuntimeResult<T> {
	return fail({
		type,
		stage,
		message: `${issues.join("; ")}${hint ? `. ${hint}` : ""}`,
		details: { issues, ...(hint ? { hint } : {}) },
	});
}

async function loadAndValidate<T>(
	path: string,
	validate: (value: unknown) => RuntimeResult<T>,
	type: string,
	stage: string,
): Promise<RuntimeResult<T>> {
	const resolvedPath = resolve(path);
	try {
		return validate(JSON.parse(await readFile(resolvedPath, "utf8")) as unknown);
	} catch (error) {
		return fail({
			type,
			stage,
			message: `Could not read ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
			details: { path: resolvedPath },
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function iterationPath(cwd: string, workflowId: string, sequence: number): string {
	return join(cwd, ".virtuoso-agent", "workflows", workflowId, "iterations", String(sequence).padStart(6, "0"));
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function getSimulationRunSkillPath(): string {
	return fileURLToPath(new URL("../../../skill-runtime/simulation-run.il", import.meta.url));
}

function getMetricExtractSkillPath(): string {
	return fileURLToPath(new URL("../../../skill-runtime/metric-extract.il", import.meta.url));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function monitorEventName(path: string): string {
	const name = basename(path);
	if (name === "spectre.out" || name === "si.foregnd.log" || name.startsWith("exprOutputs.log")) {
		return "simulation-log-progress";
	}
	return "completion-marker";
}

function isArchivableLog(path: string): boolean {
	const name = basename(path);
	return name === "spectre.out" || name === "si.foregnd.log" || name.startsWith("exprOutputs.log");
}

function matchCount(value: string, expression: RegExp): number {
	return value.match(expression)?.length ?? 0;
}

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function fileAgeMs(path: string): Promise<number | undefined> {
	try {
		return Date.now() - (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function ioFailure<T>(type: string, stage: string, path: string, error: unknown): RuntimeResult<T> {
	return fail({
		type,
		stage,
		message: error instanceof Error ? error.message : String(error),
		details: { path },
	});
}
