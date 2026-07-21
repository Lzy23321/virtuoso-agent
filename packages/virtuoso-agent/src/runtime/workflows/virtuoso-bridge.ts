import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	enqueueVirtuosoBridgeSessionCommand,
	getDefaultVirtuosoBridgePath,
	runVirtuosoBridgeExpression,
	skillString,
	startVirtuosoBridgeSession,
	startVirtuosoBridgeUi,
	type VirtuosoBridgeSessionCommandResult,
	type VirtuosoBridgeSessionStartResult,
	type VirtuosoDisplayProbe,
	type VirtuosoUiLauncher,
	type VirtuosoUiLaunchResult,
} from "../backends/virtuoso/bridge.ts";
import type { ProcessExecutor, ProcessRunResult } from "../core/process-runner.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";

export interface VirtuosoBridgeOptions {
	bridgePath?: string;
	virtuosoBin?: string;
	workDir?: string;
	cdsLib?: string;
	display?: string;
	xAuthority?: string;
	waylandDisplay?: string;
	xdgRuntimeDir?: string;
	timeoutMs?: number;
	dryRun?: boolean;
	executor?: ProcessExecutor;
	launcher?: VirtuosoUiLauncher;
	displayProbe?: VirtuosoDisplayProbe;
}

export interface VirtuosoSessionOptions extends VirtuosoBridgeOptions {
	sessionDir?: string;
	instanceId?: string;
	registryDir?: string;
	readyTimeoutMs?: number;
}

export interface VirtuosoCellViewRef {
	library: string;
	cell: string;
	view: string;
	mode: string;
}

export interface VirtuosoInstanceSummary {
	name: string;
	library: string;
	cell: string;
	view: string;
}

export interface VirtuosoInstanceParameter {
	name: string;
	value: string;
}

export interface VirtuosoInstanceList {
	cellView: VirtuosoCellViewRef;
	instances: VirtuosoInstanceSummary[];
}

export interface VirtuosoInstanceParameterList {
	cellView: VirtuosoCellViewRef;
	instance: VirtuosoInstanceSummary;
	parameters: VirtuosoInstanceParameter[];
}

export interface VirtuosoInstanceSummaryWithParameters extends VirtuosoInstanceSummary {
	parameters: VirtuosoInstanceParameter[];
}

export interface VirtuosoCellViewSummary {
	cellView: VirtuosoCellViewRef;
	counts: {
		instances: number;
	};
	instances: VirtuosoInstanceSummaryWithParameters[];
}

export interface VirtuosoInventoryView {
	name: string;
}

export interface VirtuosoInventoryCell {
	name: string;
	counts: {
		views: number;
	};
	views: VirtuosoInventoryView[];
}

export interface VirtuosoInventoryLibrary {
	name: string;
	path: string;
	counts: {
		cells: number;
		views: number;
	};
	cells: VirtuosoInventoryCell[];
}

export interface VirtuosoInventoryLibrarySummary {
	name: string;
	path: string;
	counts: {
		cells: number;
		views: number;
	};
}

export interface VirtuosoInventoryLibrariesSummary {
	counts: {
		libraries: number;
		cells: number;
		views: number;
	};
	libraries: VirtuosoInventoryLibrarySummary[];
}

export interface VirtuosoInventoryCellViewsSummary {
	library: VirtuosoInventoryLibrarySummary;
}

export interface VirtuosoInventoryArtifact {
	path: string;
	format: "json";
	kind: "libraries" | "cellviews" | "maestro-inspect";
	createdAt: string;
}

export interface VirtuosoInventoryArtifactResult<TSummary> {
	summary?: TSummary;
	artifact?: VirtuosoInventoryArtifact;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
}

export interface VirtuosoMaestroCounts {
	tests: number;
	enabledTests: number;
	globalVariables: number;
	testVariableEntries: number;
	uniqueTestVariables: number;
	parameters: {
		total: number;
		enabled: number;
		disabled: number;
		withValue: number;
	};
	corners: number;
	analysisEntries: number;
	outputs: number;
}

export interface VirtuosoMaestroInspect {
	schemaVersion: string;
	kind: "maestro-inspect";
	generatedAt: string;
	target: {
		library: string;
		cell: string;
		view: string;
	};
	source: {
		cdsLib?: string;
		openMode: "r";
		virtuosoVersion: string;
	};
	session: {
		name: string;
		valid: boolean;
		singleTest: boolean;
		modified: boolean;
		runMode: unknown;
		setupLibrary: string | null;
		closedAfterInspect: boolean;
	};
	storage: {
		path: string | null;
	};
	summary: VirtuosoMaestroCounts;
	maestro: {
		globalVariables: Array<{
			name: string;
			enabled: boolean;
			value: unknown;
			resolvedValue: unknown;
		}>;
		parameters: Array<{
			path: string;
			enabled: boolean;
			value: unknown;
		}>;
	};
	tests: Array<{
		name: string;
		enabled: boolean;
		design: { library: string | null; cell: string | null; view: string | null };
		simulator: string | null;
		analyses: Array<{
			type: string;
			enabled: boolean;
			effectiveSettings: Record<string, unknown>;
		}>;
		designVariables: Array<{ name: string; value: unknown }>;
		corners: Array<{
			name: string;
			temperature: unknown;
			processCorner: unknown[];
			modelFiles: Array<{
				configuredPath: string | null;
				path: string | null;
				available: boolean;
				section: string | null;
			}>;
			variables: Record<string, unknown>;
		}>;
		outputsSetup: Array<{
			name: string | null;
			type: string;
			details: unknown;
			plot: boolean;
			plotTarget: unknown;
			save: boolean;
			spec: null | {
				operator: string;
				target: unknown;
				display: string;
				native: unknown;
			};
		}>;
		netlist: {
			directory: string | null;
			discovery: "api" | "filesystem";
			available: boolean;
		};
	}>;
	warnings: string[];
}

export interface VirtuosoMaestroInspectSummary {
	kind: "maestro-inspect";
	target: VirtuosoMaestroInspect["target"];
	session: Pick<VirtuosoMaestroInspect["session"], "name" | "valid" | "singleTest" | "closedAfterInspect">;
	counts: VirtuosoMaestroCounts;
}

export interface VirtuosoBridgeCallResult<TValue> {
	value: TValue;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
}

export interface OpenVirtuosoCellViewRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function openVirtuosoCellView(
	request: OpenVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoBridgeCallResult<VirtuosoCellViewRef>>> {
	const mode = request.mode ?? "r";
	return runVirtuosoBridgeExpression<VirtuosoCellViewRef>({
		...request,
		expression: `vaOpenCellView(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
			request.view,
		)} ${skillString(mode)})`,
	});
}

export async function getCurrentVirtuosoCellView(
	options: VirtuosoBridgeOptions = {},
): Promise<RuntimeResult<VirtuosoBridgeCallResult<VirtuosoCellViewRef>>> {
	return runVirtuosoBridgeExpression<VirtuosoCellViewRef>({
		...options,
		expression: "vaGetCurrentCellView()",
	});
}

export async function listVirtuosoLibraries(
	options: VirtuosoBridgeOptions = {},
): Promise<RuntimeResult<VirtuosoInventoryArtifactResult<VirtuosoInventoryLibrariesSummary>>> {
	const result = await runVirtuosoBridgeExpression<VirtuosoInventoryLibrariesSummary>({
		...options,
		expression: "vaListLibraries()",
	});
	if (!result.ok) {
		return result;
	}
	if (result.value.process.dryRun) {
		return ok({
			process: result.value.process,
			scriptPath: result.value.scriptPath,
			bridgePath: result.value.bridgePath,
			cdsLib: result.value.cdsLib,
		});
	}
	const summary = summarizeInventoryLibraries(result.value.value);
	return writeInventoryArtifact({
		options,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
		kind: "libraries",
		name: "libraries",
		full: result.value.value,
		summary,
	});
}

export interface ListVirtuosoLibraryCellViewsRequest extends VirtuosoBridgeOptions {
	library: string;
}

export async function listVirtuosoLibraryCellViews(
	request: ListVirtuosoLibraryCellViewsRequest,
): Promise<RuntimeResult<VirtuosoInventoryArtifactResult<VirtuosoInventoryCellViewsSummary>>> {
	const result = await runVirtuosoBridgeExpression<VirtuosoInventoryLibrary>({
		...request,
		expression: `vaListCellViews(${skillString(request.library)})`,
	});
	if (!result.ok) {
		return result;
	}
	if (result.value.process.dryRun) {
		return ok({
			process: result.value.process,
			scriptPath: result.value.scriptPath,
			bridgePath: result.value.bridgePath,
			cdsLib: result.value.cdsLib,
		});
	}
	const summary = {
		library: summarizeInventoryLibrary(result.value.value),
	};
	return writeInventoryArtifact({
		options: request,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
		kind: "cellviews",
		name: `cellviews-${request.library}`,
		full: result.value.value,
		summary,
	});
}

export interface InspectVirtuosoCellViewRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function inspectVirtuosoMaestro(
	request: InspectVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoInventoryArtifactResult<VirtuosoMaestroInspectSummary>>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const maestroInspectPath = join(dirname(bridgePath), "maestro-inspect.il");
	const result = await runVirtuosoBridgeExpression<VirtuosoMaestroInspect>({
		...request,
		expression: `load(${skillString(maestroInspectPath)})\nvaInspectMaestro(${skillString(
			request.library,
		)} ${skillString(request.cell)} ${skillString(request.view)})`,
	});
	if (!result.ok) {
		return result;
	}
	if (result.value.process.dryRun) {
		return ok({
			process: result.value.process,
			scriptPath: result.value.scriptPath,
			bridgePath: result.value.bridgePath,
			cdsLib: result.value.cdsLib,
		});
	}
	const full: VirtuosoMaestroInspect = {
		...result.value.value,
		generatedAt: new Date().toISOString(),
		source: {
			...result.value.value.source,
			...(result.value.cdsLib ? { cdsLib: result.value.cdsLib } : {}),
		},
		warnings: [
			...result.value.value.warnings,
			...(result.value.process.exitCode === 0
				? []
				: [
						`Virtuoso returned a complete manifest but did not exit cleanly (exitCode: ${result.value.process.exitCode}).`,
					]),
		],
	};
	return writeInventoryArtifact({
		options: request,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
		kind: "maestro-inspect",
		directory: "inspect",
		name: `maestro-${request.library}-${request.cell}-${request.view}`,
		full,
		summary: summarizeMaestroInspect(full),
	});
}

export interface ListVirtuosoInstancesRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function listVirtuosoInstances(
	request: ListVirtuosoInstancesRequest,
): Promise<RuntimeResult<VirtuosoBridgeCallResult<VirtuosoInstanceList>>> {
	const mode = request.mode ?? "r";
	return runVirtuosoBridgeExpression<VirtuosoInstanceList>({
		...request,
		expression: `vaListInstances(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
			request.view,
		)} ${skillString(mode)})`,
	});
}

export interface GetVirtuosoInstanceParametersRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	instanceName: string;
	mode?: "r" | "a" | "w";
}

export async function getVirtuosoInstanceParameters(
	request: GetVirtuosoInstanceParametersRequest,
): Promise<RuntimeResult<VirtuosoBridgeCallResult<VirtuosoInstanceParameterList>>> {
	const mode = request.mode ?? "r";
	return runVirtuosoBridgeExpression<VirtuosoInstanceParameterList>({
		...request,
		expression: `vaGetInstanceParameters(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
			request.view,
		)} ${skillString(request.instanceName)} ${skillString(mode)})`,
	});
}

export interface SummarizeVirtuosoCellViewRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function summarizeVirtuosoCellView(
	request: SummarizeVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoBridgeCallResult<VirtuosoCellViewSummary>>> {
	const mode = request.mode ?? "r";
	return runVirtuosoBridgeExpression<VirtuosoCellViewSummary>({
		...request,
		expression: `vaCellViewSummary(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
			request.view,
		)} ${skillString(mode)})`,
	});
}

export async function startVirtuosoUiSession(
	options: VirtuosoSessionOptions = {},
): Promise<RuntimeResult<VirtuosoBridgeSessionStartResult>> {
	return startVirtuosoBridgeSession(options);
}

export interface ShowVirtuosoCellViewInSessionRequest {
	sessionDir: string;
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
	resultFileName?: string;
}

export async function showVirtuosoCellViewInSession(
	request: ShowVirtuosoCellViewInSessionRequest,
): Promise<RuntimeResult<VirtuosoBridgeSessionCommandResult>> {
	const mode = request.mode ?? "r";
	const resultFileName = request.resultFileName ?? `${request.library}_${request.cell}_${request.view}.json`;
	const normalizedResultFileName = resultFileName.endsWith(".json") ? resultFileName : `${resultFileName}.json`;
	const resultPath = join(request.sessionDir, "results", normalizedResultFileName);
	const expression = `vaSessionShowCellView(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
		request.view,
	)} ${skillString(mode)} ${skillString(resultPath)})`;
	return enqueueVirtuosoBridgeSessionCommand({
		sessionDir: request.sessionDir,
		resultFileName: normalizedResultFileName,
		expression,
	});
}

export interface ShowVirtuosoCellViewRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function showVirtuosoCellView(
	request: ShowVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoUiLaunchResult>> {
	const mode = request.mode ?? "r";
	return startVirtuosoBridgeUi({
		...request,
		expression: `vaShowCellView(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
			request.view,
		)} ${skillString(mode)})`,
	});
}

async function writeInventoryArtifact<TSummary>(request: {
	options: VirtuosoBridgeOptions;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
	kind: VirtuosoInventoryArtifact["kind"];
	directory?: "inventory" | "inspect";
	name: string;
	full: unknown;
	summary: TSummary;
}): Promise<RuntimeResult<VirtuosoInventoryArtifactResult<TSummary>>> {
	const createdAt = new Date().toISOString();
	const directory = getVirtuosoArtifactDir(request.options, request.process.cwd, request.directory ?? "inventory");
	const artifactPath = join(directory, `${safeArtifactName(request.name)}-${formatArtifactTimestamp(createdAt)}.json`);
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(artifactPath, `${JSON.stringify(request.full, null, 2)}\n`, "utf8");
		return ok({
			summary: request.summary,
			artifact: {
				path: artifactPath,
				format: "json",
				kind: request.kind,
				createdAt,
			},
			process: request.process,
			scriptPath: request.scriptPath,
			bridgePath: request.bridgePath,
			cdsLib: request.cdsLib,
		});
	} catch (error) {
		return fail({
			type: "inventory_artifact_write_error",
			stage: "inventory_artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { artifactPath, kind: request.kind },
		});
	}
}

function summarizeInventoryLibrary(library: VirtuosoInventoryLibrarySummary): VirtuosoInventoryLibrarySummary {
	return {
		name: library.name,
		path: library.path,
		counts: library.counts,
	};
}

function summarizeInventoryLibraries(inventory: VirtuosoInventoryLibrariesSummary): VirtuosoInventoryLibrariesSummary {
	return {
		counts: inventory.counts,
		libraries: inventory.libraries.map(summarizeInventoryLibrary),
	};
}

function summarizeMaestroInspect(inspect: VirtuosoMaestroInspect): VirtuosoMaestroInspectSummary {
	return {
		kind: inspect.kind,
		target: inspect.target,
		session: {
			name: inspect.session.name,
			valid: inspect.session.valid,
			singleTest: inspect.session.singleTest,
			closedAfterInspect: inspect.session.closedAfterInspect,
		},
		counts: inspect.summary,
	};
}

function getVirtuosoArtifactDir(
	options: VirtuosoBridgeOptions,
	processCwd: string,
	artifactKind: "inventory" | "inspect",
): string {
	const baseDir = options.workDir ?? (options.cdsLib ? dirname(resolve(options.cdsLib)) : processCwd);
	return join(resolve(baseDir), ".virtuoso-agent", artifactKind);
}

function safeArtifactName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "inventory";
}

function formatArtifactTimestamp(value: string): string {
	return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
