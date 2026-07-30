import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { executeVirtuosoBridgeSessionCommand, skillString } from "../backends/virtuoso/bridge.ts";
import {
	type LiveManagedVirtuosoInstance,
	resolveManagedVirtuosoInstance,
} from "../backends/virtuoso/instance-registry.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import type { ManagedVirtuosoRequest } from "./managed-virtuoso.ts";
import {
	exportManagedMaestroBundle,
	exportManagedSchematicBundle,
	type SimulationBundleResult,
} from "./simulation-bundle.ts";

export type ModificationMode = "validate" | "dry-run" | "apply";
export type BaselinePolicy = "if-missing" | "reuse" | "always" | "none";
export type AnalysisSettingValue = string | number | boolean | string[];

export interface ModificationCellViewTarget {
	library: string;
	cell: string;
	view: string;
}

export interface DeviceParameterModification {
	id: string;
	operation: "set";
	instance: string;
	expect?: {
		master?: ModificationCellViewTarget;
		parameters?: Record<string, string>;
	};
	parameters: Record<
		string,
		{
			value: string;
			valueType?: "expression" | "string";
		}
	>;
}

export interface AnalysisModification {
	id: string;
	operation: "add" | "delete";
	analysis?: {
		name: string;
		type: string;
		settings?: Record<string, AnalysisSettingValue>;
	};
	selector?: {
		name: string;
		type?: string;
	};
	expect?: {
		settings?: Record<string, AnalysisSettingValue>;
	};
}

export interface OutputModification {
	id: string;
	operation: "add" | "delete";
	output?: {
		name: string;
		type?: "expression" | "point" | "corners" | "sweeps" | "all" | "terminal" | "terminalV" | "net";
		expression?: string;
		signalName?: string;
		plot?: boolean;
		save?: boolean;
	};
	selector?: {
		name: string;
	};
	expect?: {
		expression?: string;
	};
}

export interface TestModification {
	testName: string;
	analyses?: AnalysisModification[];
	outputs?: OutputModification[];
}

export interface VirtuosoModificationPlan {
	schemaVersion: 1;
	kind: "virtuoso-modification-plan";
	metadata?: {
		planId?: string;
		description?: string;
	};
	workflow?: {
		id: string;
		sequence: number;
		baselineId?: string;
	};
	beforeApply?: {
		baselineExport?: {
			policy: BaselinePolicy;
			profile?: "full";
			onUnavailableResults?: "record-and-continue" | "error";
		};
	};
	targets: {
		schematic?: ModificationCellViewTarget;
		maestro?: ModificationCellViewTarget;
	};
	options?: {
		stopOnError?: boolean;
		savePolicy?: "all-on-success";
		onConflict?: "error";
		runSchematicCheck?: boolean;
	};
	changes: {
		deviceParameters?: DeviceParameterModification[];
		tests?: TestModification[];
	};
}

export interface ModifyVirtuosoRequest extends ManagedVirtuosoRequest {
	planPath: string;
	mode: ModificationMode;
	outputDirectory?: string;
}

export interface ModificationExecutionSnapshot {
	apply: boolean;
	deviceParameters: Array<{
		id: string;
		instance: string;
		parameters: Array<{ name: string; before: string; after: string }>;
	}>;
	analyses: Array<{
		id: string;
		testName: string;
		analysis: string;
		operation: "add" | "delete";
		beforeEnabled: boolean;
		afterEnabled: boolean;
	}>;
	outputs: Array<{
		id: string;
		testName: string;
		output: string;
		operation: "add" | "delete";
		beforeExists: boolean;
		afterExists: boolean;
	}>;
	schematic: {
		saved: boolean;
		check: string;
		uiStatus: "refreshed" | "not-open" | "not-applicable";
	};
	maestro: {
		saved: boolean;
		uiStatus: "refreshed" | "not-open" | "not-applicable";
	};
	verification: {
		deviceParameters: Array<{
			id: string;
			instance: string;
			parameters: Array<{ name: string; actual: string }>;
		}>;
		analyses: Array<{ id: string; enabled: boolean }>;
		outputs: Array<{ id: string; exists: boolean }>;
	} | null;
}

export interface ModificationResult {
	mode: ModificationMode;
	planPath: string;
	plan: VirtuosoModificationPlan;
	validation: {
		status: "passed";
		operationCount: number;
	};
	workflowDirectory?: string;
	stepDirectory?: string;
	baseline?: {
		id: string;
		reused: boolean;
		bundleDirectory: string;
		manifestPath: string;
		warnings: string[];
	};
	snapshot?: ModificationExecutionSnapshot;
	reportPath?: string;
	generatedSkillPath?: string;
	instance?: LiveManagedVirtuosoInstance;
}

interface WorkflowState {
	schemaVersion: 1;
	workflowId: string;
	status: "active";
	baselineId?: string;
	baselineCreated: boolean;
	lastCompletedSequence: number;
	nextSequence: number;
	targets: VirtuosoModificationPlan["targets"];
}

interface BaselineRecord {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	profile: "full";
	bundleDirectory: string;
	manifestPath: string;
	warnings: string[];
}

export async function loadVirtuosoModificationPlan(path: string): Promise<RuntimeResult<VirtuosoModificationPlan>> {
	const resolvedPath = resolve(path);
	try {
		const value: unknown = JSON.parse(await readFile(resolvedPath, "utf8"));
		return validateVirtuosoModificationPlan(value);
	} catch (error) {
		return fail({
			type: "modification_plan_read_error",
			stage: "modification_plan_read",
			message: `Could not read modification plan ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
			details: { path: resolvedPath },
		});
	}
}

export function validateVirtuosoModificationPlan(value: unknown): RuntimeResult<VirtuosoModificationPlan> {
	const issues: string[] = [];
	if (!isRecord(value)) {
		return invalidPlan(["plan must be a JSON object"]);
	}
	if (value.schemaVersion !== 1) {
		issues.push("schemaVersion must be 1");
	}
	if (value.kind !== "virtuoso-modification-plan") {
		issues.push('kind must be "virtuoso-modification-plan"');
	}
	const targets = value.targets;
	if (!isRecord(targets)) {
		issues.push("targets must be an object");
	} else {
		validateTarget(targets.schematic, "targets.schematic", issues);
		validateTarget(targets.maestro, "targets.maestro", issues);
	}
	const changes = value.changes;
	let operationCount = 0;
	const operationIds = new Set<string>();
	const deviceTargets = new Set<string>();
	if (!isRecord(changes)) {
		issues.push("changes must be an object");
	} else {
		if (changes.deviceParameters !== undefined && !Array.isArray(changes.deviceParameters)) {
			issues.push("changes.deviceParameters must be an array");
		}
		for (const [index, operation] of arrayValue(changes.deviceParameters).entries()) {
			operationCount++;
			validateDeviceOperation(operation, `changes.deviceParameters[${index}]`, issues, operationIds, deviceTargets);
		}
		if (changes.tests !== undefined && !Array.isArray(changes.tests)) {
			issues.push("changes.tests must be an array");
		}
		for (const [testIndex, test] of arrayValue(changes.tests).entries()) {
			if (!isRecord(test) || !isNonEmptyString(test.testName)) {
				issues.push(`changes.tests[${testIndex}].testName must be a non-empty string`);
				continue;
			}
			for (const [index, operation] of arrayValue(test.analyses).entries()) {
				operationCount++;
				validateAnalysisOperation(
					operation,
					`changes.tests[${testIndex}].analyses[${index}]`,
					issues,
					operationIds,
				);
			}
			for (const [index, operation] of arrayValue(test.outputs).entries()) {
				operationCount++;
				validateOutputOperation(operation, `changes.tests[${testIndex}].outputs[${index}]`, issues, operationIds);
			}
		}
	}
	if (operationCount === 0) {
		issues.push("changes must contain at least one operation");
	}
	const hasDevices = isRecord(changes) && arrayValue(changes.deviceParameters).length > 0;
	const hasTests =
		isRecord(changes) &&
		arrayValue(changes.tests).some(
			(test) => isRecord(test) && (arrayValue(test.analyses).length > 0 || arrayValue(test.outputs).length > 0),
		);
	if (hasDevices && (!isRecord(targets) || !isTarget(targets.schematic))) {
		issues.push("targets.schematic is required for device parameter modifications");
	}
	if (hasTests && (!isRecord(targets) || !isTarget(targets.maestro))) {
		issues.push("targets.maestro is required for test analysis/output modifications");
	}
	if (value.workflow !== undefined) {
		if (!isRecord(value.workflow)) {
			issues.push("workflow must be an object");
		} else {
			if (!isNonEmptyString(value.workflow.id)) {
				issues.push("workflow.id must be a non-empty string");
			}
			if (!Number.isInteger(value.workflow.sequence) || Number(value.workflow.sequence) < 1) {
				issues.push("workflow.sequence must be a positive integer");
			}
		}
	}
	const baseline = isRecord(value.beforeApply) ? value.beforeApply.baselineExport : undefined;
	if (baseline !== undefined) {
		if (!isRecord(baseline) || !["if-missing", "reuse", "always", "none"].includes(String(baseline.policy))) {
			issues.push("beforeApply.baselineExport.policy must be if-missing, reuse, always, or none");
		}
		if (isRecord(baseline) && baseline.profile !== undefined && baseline.profile !== "full") {
			issues.push('beforeApply.baselineExport.profile must be "full"');
		}
	}
	if (value.options !== undefined) {
		if (!isRecord(value.options)) {
			issues.push("options must be an object");
		} else {
			if ("createBackup" in value.options) {
				issues.push(
					"options.createBackup is unsupported; use beforeApply.baselineExport for the initial review baseline",
				);
			}
			if (value.options.stopOnError !== undefined && value.options.stopOnError !== true) {
				issues.push("options.stopOnError currently supports only true");
			}
			if (value.options.savePolicy !== undefined && value.options.savePolicy !== "all-on-success") {
				issues.push('options.savePolicy must be "all-on-success"');
			}
			if (value.options.onConflict !== undefined && value.options.onConflict !== "error") {
				issues.push('options.onConflict must be "error"');
			}
			if (value.options.runSchematicCheck !== undefined && typeof value.options.runSchematicCheck !== "boolean") {
				issues.push("options.runSchematicCheck must be a boolean");
			}
		}
	}
	return issues.length > 0 ? invalidPlan(issues) : ok(value as unknown as VirtuosoModificationPlan);
}

export function renderVirtuosoModificationSkill(
	plan: VirtuosoModificationPlan,
	applyChanges: boolean,
	resultPath: string,
	modificationSkillPath: string,
): string {
	const schematic = plan.targets.schematic;
	const maestro = plan.targets.maestro;
	const deviceOperations = plan.changes.deviceParameters ?? [];
	const analysisOperations: Array<
		[string, string, string, string, Record<string, AnalysisSettingValue>, Record<string, AnalysisSettingValue>]
	> = [];
	const outputOperations: Array<[string, string, string, string, string, string, string, boolean, boolean, string]> =
		[];
	for (const test of plan.changes.tests ?? []) {
		for (const operation of test.analyses ?? []) {
			const analysisName =
				operation.operation === "add"
					? (operation.analysis?.name ?? operation.analysis?.type ?? "")
					: (operation.selector?.name ?? operation.selector?.type ?? "");
			analysisOperations.push([
				operation.id,
				test.testName,
				operation.operation,
				analysisName,
				operation.operation === "add" ? (operation.analysis?.settings ?? {}) : {},
				operation.expect?.settings ?? {},
			]);
		}
		for (const operation of test.outputs ?? []) {
			const output = operation.output;
			const outputType = output?.type === "expression" || output?.type === undefined ? "point" : output.type;
			outputOperations.push([
				operation.id,
				test.testName,
				operation.operation,
				output?.name ?? operation.selector?.name ?? "",
				outputType,
				output?.expression ?? "",
				output?.signalName ?? "",
				output?.plot ?? false,
				output?.save ?? false,
				operation.expect?.expression ?? "",
			]);
		}
	}
	const renderedDevices = skillList(
		deviceOperations.map((operation) =>
			skillList([
				skillString(operation.id),
				skillString(operation.instance),
				skillList(
					Object.entries(operation.parameters).map(([name, parameter]) =>
						skillList([skillString(name), skillString(parameter.value)]),
					),
				),
				skillList(
					Object.entries(operation.expect?.parameters ?? {}).map(([name, expected]) =>
						skillList([skillString(name), skillString(expected)]),
					),
				),
				operation.expect?.master
					? skillList([
							skillString(operation.expect.master.library),
							skillString(operation.expect.master.cell),
							skillString(operation.expect.master.view),
						])
					: "nil",
			]),
		),
	);
	const renderedAnalyses = skillList(
		analysisOperations.map(([id, testName, operation, analysisName, settings, expectedSettings]) =>
			skillList([
				skillString(id),
				skillString(testName),
				skillString(operation),
				skillString(analysisName),
				skillList(
					Object.entries(settings).map(([name, setting]) =>
						skillList([skillString(name), renderSkillValue(setting)]),
					),
				),
				skillList(
					Object.entries(expectedSettings).map(([name, setting]) =>
						skillList([skillString(name), renderSkillValue(setting)]),
					),
				),
			]),
		),
	);
	const renderedOutputs = skillList(
		outputOperations.map((operation) =>
			skillList([
				skillString(operation[0]),
				skillString(operation[1]),
				skillString(operation[2]),
				skillString(operation[3]),
				skillString(operation[4]),
				skillString(operation[5]),
				skillString(operation[6]),
				operation[7] ? "t" : "nil",
				operation[8] ? "t" : "nil",
				skillString(operation[9]),
			]),
		),
	);
	return [
		`unless(isCallable('vaModificationExecute) load(${skillString(modificationSkillPath)}))`,
		"vaModificationExecute(",
		`  ${skillString(schematic?.library ?? "")} ${skillString(schematic?.cell ?? "")} ${skillString(schematic?.view ?? "")}`,
		`  ${skillString(maestro?.library ?? "")} ${skillString(maestro?.cell ?? "")} ${skillString(maestro?.view ?? "")}`,
		`  ${renderedDevices}`,
		`  ${renderedAnalyses}`,
		`  ${renderedOutputs}`,
		`  ${plan.options?.runSchematicCheck === false ? "nil" : "t"}`,
		`  ${applyChanges ? "t" : "nil"}`,
		`  ${skillString(resultPath)}`,
		")",
	].join("\n");
}

export async function modifyManagedVirtuoso(
	request: ModifyVirtuosoRequest,
): Promise<RuntimeResult<ModificationResult>> {
	const planPath = resolve(request.planPath);
	const loaded = await loadVirtuosoModificationPlan(planPath);
	if (!loaded.ok) {
		return loaded;
	}
	const plan = loaded.value;
	const operationCount = countOperations(plan);
	if (request.mode === "validate") {
		return ok({
			mode: request.mode,
			planPath,
			plan,
			validation: { status: "passed", operationCount },
		});
	}
	const resolvedInstance = await resolveManagedVirtuosoInstance({
		registryDir: request.registryDir,
		instanceId: request.instanceId,
		cdsLib: request.cdsLib,
		requireUi: true,
	});
	if (!resolvedInstance.ok) {
		return resolvedInstance;
	}
	const instance = resolvedInstance.value;
	const workflowId = plan.workflow?.id ?? `adhoc-${randomUUID()}`;
	const sequence = plan.workflow?.sequence ?? 1;
	const workflowDirectory = resolve(
		request.outputDirectory ?? join(instance.cwd, ".virtuoso-agent", "modifications"),
		safeName(workflowId),
	);
	return withWorkflowLock(workflowDirectory, async () => {
		const statePath = join(workflowDirectory, "workflow.json");
		const workflowState = await loadWorkflowState(statePath);
		if (!workflowState.ok) {
			return workflowState;
		}
		const sequenceValidation = validateWorkflowSequence(plan, workflowState.value);
		if (!sequenceValidation.ok) {
			return sequenceValidation;
		}
		const stepDirectory = join(workflowDirectory, "steps", String(sequence).padStart(3, "0"));
		try {
			await mkdir(stepDirectory, { recursive: true });
			await writeJson(join(stepDirectory, "plan.json"), plan);
			await writeJson(join(stepDirectory, "resolved-plan.json"), {
				...plan,
				resolvedAt: new Date().toISOString(),
				managedInstanceId: instance.instanceId,
				mode: request.mode,
			});
		} catch (error) {
			return modificationIoFailure("modification_prepare", stepDirectory, error);
		}

		let baseline: ModificationResult["baseline"];
		if (request.mode === "apply") {
			const preparedBaseline = await prepareBaseline(plan, instance, workflowDirectory, request.timeoutMs);
			if (!preparedBaseline.ok) {
				return preparedBaseline;
			}
			baseline = preparedBaseline.value;
		}

		const modificationSkillPath = join(dirname(instance.bridgePath), "modification.il");
		const generatedSkillPath = join(stepDirectory, "generated.il");
		const artifactScript = renderVirtuosoModificationSkill(
			plan,
			request.mode === "apply",
			join(stepDirectory, "skill-result.json"),
			modificationSkillPath,
		);
		try {
			await writeFile(generatedSkillPath, `${artifactScript}\n`, "utf8");
		} catch (error) {
			return modificationIoFailure("modification_skill_write", generatedSkillPath, error);
		}

		const preflight = await executeModification(instance, plan, false, modificationSkillPath, request.timeoutMs);
		if (!preflight.ok) {
			return preflight;
		}
		try {
			await writeJson(join(stepDirectory, "before.json"), preflight.value);
		} catch (error) {
			return modificationIoFailure("modification_before_write", stepDirectory, error);
		}
		let snapshot = preflight.value;
		if (request.mode === "apply") {
			const applied = await executeModification(instance, plan, true, modificationSkillPath, request.timeoutMs);
			if (!applied.ok) {
				return applied;
			}
			snapshot = applied.value;
			try {
				await writeJson(join(stepDirectory, "after.json"), snapshot);
			} catch (error) {
				return modificationIoFailure("modification_after_write", stepDirectory, error);
			}
		}
		const reportPath = join(stepDirectory, "report.json");
		const report = {
			schemaVersion: 1,
			workflowId,
			sequence,
			mode: request.mode,
			status: request.mode === "apply" ? "success" : "planned",
			baseline: baseline ?? null,
			operations: snapshot,
			completedAt: new Date().toISOString(),
		};
		try {
			await writeJson(reportPath, report);
			if (request.mode === "apply") {
				const state: WorkflowState = {
					schemaVersion: 1,
					workflowId,
					status: "active",
					baselineId: baseline?.id ?? workflowState.value?.baselineId,
					baselineCreated: Boolean(baseline || workflowState.value?.baselineCreated),
					lastCompletedSequence: sequence,
					nextSequence: sequence + 1,
					targets: plan.targets,
				};
				await writeJson(statePath, state);
			}
		} catch (error) {
			return modificationIoFailure("modification_report_write", reportPath, error);
		}
		return ok({
			mode: request.mode,
			planPath,
			plan,
			validation: { status: "passed", operationCount },
			workflowDirectory,
			stepDirectory,
			baseline,
			snapshot,
			reportPath,
			generatedSkillPath,
			instance,
		});
	});
}

async function withWorkflowLock<T>(
	workflowDirectory: string,
	operation: () => Promise<RuntimeResult<T>>,
): Promise<RuntimeResult<T>> {
	const lockPath = join(workflowDirectory, ".workflow.lock");
	try {
		await mkdir(workflowDirectory, { recursive: true });
	} catch (error) {
		return modificationIoFailure("modification_lock_prepare", workflowDirectory, error);
	}
	let lock: Awaited<ReturnType<typeof open>>;
	try {
		lock = await open(lockPath, "wx");
		await lock.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			return fail({
				type: "modification_workflow_busy",
				stage: "workflow_lock",
				message: `Another modification is already using workflow directory: ${workflowDirectory}`,
				details: { workflowDirectory, lockPath },
			});
		}
		return modificationIoFailure("modification_lock_acquire", lockPath, error);
	}
	try {
		return await operation();
	} finally {
		await lock.close().catch(() => undefined);
		await unlink(lockPath).catch(() => undefined);
	}
}

async function executeModification(
	instance: LiveManagedVirtuosoInstance,
	plan: VirtuosoModificationPlan,
	applyChanges: boolean,
	modificationSkillPath: string,
	timeoutMs?: number,
): Promise<RuntimeResult<ModificationExecutionSnapshot>> {
	const executed = await executeVirtuosoBridgeSessionCommand<ModificationExecutionSnapshot>({
		sessionDir: instance.sessionDir,
		heartbeatPath: instance.heartbeatPath,
		expression: (resultPath) =>
			renderVirtuosoModificationSkill(plan, applyChanges, resultPath, modificationSkillPath),
		timeoutMs,
	});
	return executed.ok ? ok(executed.value.value) : executed;
}

async function prepareBaseline(
	plan: VirtuosoModificationPlan,
	instance: LiveManagedVirtuosoInstance,
	workflowDirectory: string,
	timeoutMs?: number,
): Promise<RuntimeResult<ModificationResult["baseline"]>> {
	const config = plan.beforeApply?.baselineExport;
	const policy = config?.policy ?? "none";
	if (policy === "none") {
		return ok(undefined);
	}
	const baselineDirectory = join(workflowDirectory, "baseline");
	const recordPath = join(baselineDirectory, "baseline.json");
	const existing = await readJsonIfExists<BaselineRecord>(recordPath);
	if (!existing.ok) {
		return existing;
	}
	if ((policy === "reuse" || policy === "if-missing") && existing.value) {
		if (!(await pathExists(existing.value.manifestPath))) {
			return fail({
				type: "modification_baseline_missing",
				stage: "baseline_prepare",
				message: `Baseline manifest is missing: ${existing.value.manifestPath}`,
			});
		}
		return ok({
			id: existing.value.id,
			reused: true,
			bundleDirectory: existing.value.bundleDirectory,
			manifestPath: existing.value.manifestPath,
			warnings: existing.value.warnings,
		});
	}
	if (policy === "reuse") {
		return fail({
			type: "modification_baseline_required",
			stage: "baseline_prepare",
			message: "baselineExport policy reuse requires an existing baseline.",
		});
	}
	const exported = await exportFullBaseline(plan, instance, join(baselineDirectory, "export"), timeoutMs, config);
	if (!exported.ok) {
		return exported;
	}
	const id = `baseline-${new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14)}`;
	const record: BaselineRecord = {
		schemaVersion: 1,
		id,
		createdAt: new Date().toISOString(),
		profile: "full",
		bundleDirectory: exported.value.bundleDirectory,
		manifestPath: exported.value.manifest.path,
		warnings: exported.value.warnings,
	};
	try {
		await mkdir(baselineDirectory, { recursive: true });
		await writeJson(recordPath, record);
	} catch (error) {
		return modificationIoFailure("baseline_record_write", recordPath, error);
	}
	return ok({
		id,
		reused: false,
		bundleDirectory: record.bundleDirectory,
		manifestPath: record.manifestPath,
		warnings: record.warnings,
	});
}

async function exportFullBaseline(
	plan: VirtuosoModificationPlan,
	instance: LiveManagedVirtuosoInstance,
	outputDirectory: string,
	timeoutMs: number | undefined,
	config: { onUnavailableResults?: "record-and-continue" | "error" } | undefined,
): Promise<RuntimeResult<SimulationBundleResult>> {
	if (plan.targets.maestro) {
		const target = plan.targets.maestro;
		const all = await exportManagedMaestroBundle({
			...target,
			instanceId: instance.instanceId,
			outputDirectory,
			scope: "all",
			outputs: "all",
			schematicInstances: "top-level",
			timeoutMs,
		});
		if (all.ok || config?.onUnavailableResults !== "record-and-continue") {
			return all;
		}
		const definitions = await exportManagedMaestroBundle({
			...target,
			instanceId: instance.instanceId,
			outputDirectory,
			scope: "all",
			outputs: "definitions",
			schematicInstances: "top-level",
			timeoutMs,
		});
		if (definitions.ok) {
			definitions.value.warnings.push("Output results were unavailable; baseline contains output definitions only.");
		}
		return definitions;
	}
	const target = plan.targets.schematic;
	if (!target) {
		return fail({
			type: "modification_baseline_target_missing",
			stage: "baseline_prepare",
			message: "A baseline export requires a schematic or Maestro target.",
		});
	}
	return exportManagedSchematicBundle({
		...target,
		instanceId: instance.instanceId,
		outputDirectory,
		netlist: "spectre",
		schematicInstances: "top-level",
		timeoutMs,
	});
}

function validateWorkflowSequence(
	plan: VirtuosoModificationPlan,
	state: WorkflowState | undefined,
): RuntimeResult<void> {
	if (!plan.workflow) {
		return ok(undefined);
	}
	if (!state && plan.workflow.sequence !== 1) {
		return fail({
			type: "modification_workflow_sequence_invalid",
			stage: "workflow_validation",
			message: `A new workflow must start at sequence 1, not ${plan.workflow.sequence}.`,
		});
	}
	if (state && plan.workflow.sequence !== state.nextSequence) {
		return fail({
			type: "modification_workflow_sequence_invalid",
			stage: "workflow_validation",
			message: `Workflow ${state.workflowId} expects sequence ${state.nextSequence}, not ${plan.workflow.sequence}.`,
		});
	}
	if (state && state.workflowId !== plan.workflow.id) {
		return fail({
			type: "modification_workflow_id_conflict",
			stage: "workflow_validation",
			message: `Workflow directory belongs to ${state.workflowId}, not ${plan.workflow.id}.`,
		});
	}
	if (state && JSON.stringify(state.targets) !== JSON.stringify(plan.targets)) {
		return fail({
			type: "modification_workflow_target_conflict",
			stage: "workflow_validation",
			message: `Workflow ${state.workflowId} cannot change its schematic or Maestro targets.`,
		});
	}
	if (state?.baselineId && plan.workflow.baselineId && state.baselineId !== plan.workflow.baselineId) {
		return fail({
			type: "modification_workflow_baseline_conflict",
			stage: "workflow_validation",
			message: `Workflow ${state.workflowId} uses baseline ${state.baselineId}, not ${plan.workflow.baselineId}.`,
		});
	}
	return ok(undefined);
}

async function loadWorkflowState(path: string): Promise<RuntimeResult<WorkflowState | undefined>> {
	return readJsonIfExists<WorkflowState>(path);
}

async function readJsonIfExists<T>(path: string): Promise<RuntimeResult<T | undefined>> {
	try {
		return ok(JSON.parse(await readFile(path, "utf8")) as T);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return ok(undefined);
		}
		return fail({
			type: "modification_artifact_read_error",
			stage: "modification_artifact_read",
			message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

function validateTarget(value: unknown, path: string, issues: string[]): void {
	if (value !== undefined && !isTarget(value)) {
		issues.push(`${path} must contain non-empty library, cell, and view strings`);
	}
}

function validateDeviceOperation(
	value: unknown,
	path: string,
	issues: string[],
	ids: Set<string>,
	targets: Set<string>,
): void {
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}
	validateOperationId(value.id, path, issues, ids);
	if (value.operation !== "set") {
		issues.push(`${path}.operation must be set`);
	}
	if (!isNonEmptyString(value.instance)) {
		issues.push(`${path}.instance must be a non-empty string`);
	}
	if (!isRecord(value.parameters) || Object.keys(value.parameters).length === 0) {
		issues.push(`${path}.parameters must be a non-empty object`);
	} else {
		for (const [name, parameter] of Object.entries(value.parameters)) {
			const target = `${String(value.instance)}::${name}`;
			if (targets.has(target)) {
				issues.push(`${path}.parameters.${name} modifies the same instance parameter more than once`);
			}
			targets.add(target);
			if (!isNonEmptyString(name) || !isRecord(parameter) || !isNonEmptyString(parameter.value)) {
				issues.push(`${path}.parameters.${name} must contain a non-empty string value`);
			}
		}
	}
}

function validateAnalysisOperation(value: unknown, path: string, issues: string[], ids: Set<string>): void {
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}
	validateOperationId(value.id, path, issues, ids);
	if (value.operation !== "add" && value.operation !== "delete") {
		issues.push(`${path}.operation must be add or delete`);
		return;
	}
	if (value.operation === "add") {
		if (
			!isRecord(value.analysis) ||
			!isNonEmptyString(value.analysis.name) ||
			!isNonEmptyString(value.analysis.type)
		) {
			issues.push(`${path}.analysis must contain non-empty name and type strings`);
		} else if (value.analysis.name !== value.analysis.type) {
			issues.push(`${path}.analysis.name and type must match for Cadence MAE analyses`);
		}
		if (
			isRecord(value.analysis) &&
			value.analysis.settings !== undefined &&
			!isAnalysisSettings(value.analysis.settings)
		) {
			issues.push(`${path}.analysis.settings contains an unsupported value`);
		}
	} else if (!isRecord(value.selector) || !isNonEmptyString(value.selector.name)) {
		issues.push(`${path}.selector.name must be a non-empty string`);
	}
}

function validateOutputOperation(value: unknown, path: string, issues: string[], ids: Set<string>): void {
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}
	validateOperationId(value.id, path, issues, ids);
	if (value.operation !== "add" && value.operation !== "delete") {
		issues.push(`${path}.operation must be add or delete`);
		return;
	}
	if (value.operation === "add") {
		if (!isRecord(value.output) || !isNonEmptyString(value.output.name)) {
			issues.push(`${path}.output.name must be a non-empty string`);
			return;
		}
		const type = value.output.type ?? "expression";
		if (!["expression", "point", "corners", "sweeps", "all", "terminal", "terminalV", "net"].includes(String(type))) {
			issues.push(`${path}.output.type is unsupported`);
		}
		if (
			["expression", "point", "corners", "sweeps", "all"].includes(String(type)) &&
			!isNonEmptyString(value.output.expression)
		) {
			issues.push(`${path}.output.expression is required for expression outputs`);
		}
		if (["terminal", "terminalV", "net"].includes(String(type)) && !isNonEmptyString(value.output.signalName)) {
			issues.push(`${path}.output.signalName is required for signal outputs`);
		}
	} else if (!isRecord(value.selector) || !isNonEmptyString(value.selector.name)) {
		issues.push(`${path}.selector.name must be a non-empty string`);
	}
}

function validateOperationId(value: unknown, path: string, issues: string[], ids: Set<string>): void {
	if (!isNonEmptyString(value)) {
		issues.push(`${path}.id must be a non-empty string`);
		return;
	}
	if (ids.has(value)) {
		issues.push(`${path}.id duplicates operation id ${value}`);
	}
	ids.add(value);
}

function isAnalysisSettings(value: unknown): value is Record<string, AnalysisSettingValue> {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(item) =>
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean" ||
				(Array.isArray(item) && item.every((entry) => typeof entry === "string")),
		)
	);
}

function isTarget(value: unknown): value is ModificationCellViewTarget {
	return (
		isRecord(value) && isNonEmptyString(value.library) && isNonEmptyString(value.cell) && isNonEmptyString(value.view)
	);
}

function invalidPlan(issues: string[]): RuntimeResult<never> {
	return fail({
		type: "modification_plan_invalid",
		stage: "modification_plan_validation",
		message: `Modification plan is invalid: ${issues.join("; ")}.`,
		details: { issues },
	});
}

function countOperations(plan: VirtuosoModificationPlan): number {
	return (
		(plan.changes.deviceParameters?.length ?? 0) +
		(plan.changes.tests ?? []).reduce(
			(total, test) => total + (test.analyses?.length ?? 0) + (test.outputs?.length ?? 0),
			0,
		)
	);
}

function renderSkillValue(value: AnalysisSettingValue): string {
	if (typeof value === "string") {
		return skillString(value);
	}
	if (typeof value === "boolean") {
		return value ? "t" : "nil";
	}
	if (typeof value === "number") {
		return String(value);
	}
	return skillList(value.map(skillString));
}

function skillList(items: string[]): string {
	return items.length === 0 ? "nil" : `list(${items.join(" ")})`;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function safeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function modificationIoFailure(stage: string, path: string, error: unknown): RuntimeResult<never> {
	return fail({
		type: "modification_io_error",
		stage,
		message: `Could not prepare modification artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
		details: { path },
	});
}
