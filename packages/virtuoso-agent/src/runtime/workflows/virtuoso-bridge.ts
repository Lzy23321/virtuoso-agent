import { dirname, join } from "node:path";
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
import type { ArtifactRef, CellViewRef, InspectResult } from "../core/inspection.ts";
import type { ProcessExecutor, ProcessRunResult } from "../core/process-runner.ts";
import { ok, type RuntimeResult } from "../core/result.ts";
import {
	finalizeMaestroInspection,
	finalizeSchematicInspection,
	finalizeVirtuosoLibrariesInventory,
	finalizeVirtuosoLibraryCellViewsInventory,
} from "./inspection-results.ts";

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

export interface VirtuosoCellViewRef extends CellViewRef {
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

export interface VirtuosoInventoryArtifact extends ArtifactRef {
	format: "json";
	kind: "libraries" | "cellviews" | "maestro-inspect" | "schematic-inspect";
}

export interface VirtuosoInventoryArtifactResult<TSummary> {
	summary?: TSummary;
	artifact?: VirtuosoInventoryArtifact;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
}

export interface VirtuosoInspectionResult<TSummary> extends InspectResult<TSummary> {
	inspection: "completed";
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
}

export interface VirtuosoInspectionDryRunResult {
	inspection: "dry-run";
	target: CellViewRef;
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
	target: CellViewRef;
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
	session: Pick<VirtuosoMaestroInspect["session"], "name" | "valid" | "singleTest" | "closedAfterInspect">;
	counts: VirtuosoMaestroCounts;
}

export type VirtuosoSchematicJsonValue = string | number | boolean | null | VirtuosoSchematicJsonValue[];

export interface VirtuosoSchematicCounts {
	instances: number;
	topTerminals: number;
	instanceTerminals: number;
	nets: number;
	connectedEndpoints: number;
	unconnectedEndpoints: number;
	referencedMasters: number;
}

export interface VirtuosoSchematicMaster extends CellViewRef {}

export interface VirtuosoSchematicInstance {
	name: string;
	master: VirtuosoSchematicMaster;
	placement: {
		x: number | null;
		y: number | null;
		orientation: string | null;
	};
	parameters: Record<string, VirtuosoSchematicJsonValue>;
}

export interface VirtuosoSchematicTerminal {
	name: string;
	direction: string | null;
	width: number;
}

export interface VirtuosoSchematicNet {
	name: string;
	signalType: string | null;
	isGlobal: boolean;
	width: number;
}

export interface VirtuosoSchematicConnection {
	net: string | null;
	endpoint:
		| {
				kind: "instance-terminal";
				instance: string;
				terminal: string;
				direction: string | null;
				width: number;
		  }
		| {
				kind: "top-terminal";
				terminal: string;
				direction: string | null;
				width: number;
		  };
}

export interface VirtuosoSchematicReference {
	master: VirtuosoSchematicMaster;
	instanceCount: number;
	instances: string[];
}

export interface VirtuosoSchematicInspect {
	schemaVersion: "0.1";
	kind: "schematic-inspect";
	generatedAt: string;
	target: CellViewRef;
	source: {
		cdsLib?: string;
		openMode: "r";
		virtuosoVersion: string;
	};
	connectivity: {
		status: string;
	};
	summary: VirtuosoSchematicCounts;
	instances: VirtuosoSchematicInstance[];
	terminals: VirtuosoSchematicTerminal[];
	nets: VirtuosoSchematicNet[];
	connections: VirtuosoSchematicConnection[];
	references: VirtuosoSchematicReference[];
	warnings: string[];
}

export interface VirtuosoSchematicInspectSummary {
	kind: "schematic-inspect";
	connectivityStatus: string;
	counts: VirtuosoSchematicCounts;
	devices: Array<{
		master: VirtuosoSchematicMaster;
		count: number;
		instances: string[];
	}>;
	instances: Array<{
		name: string;
		master: VirtuosoSchematicMaster;
		parameters: Record<string, VirtuosoSchematicJsonValue>;
	}>;
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

/**
 * @deprecated Use showManagedVirtuosoCellView for agent and CLI workflows.
 * This compatibility API starts a one-shot bridge process and does not preserve
 * the opened database handle after that process exits.
 */
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
	const finalized = await finalizeVirtuosoLibrariesInventory(result.value.value, {
		cwd: result.value.process.cwd,
		cdsLib: result.value.cdsLib,
		workDir: options.workDir,
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		...finalized.value,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
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
	const finalized = await finalizeVirtuosoLibraryCellViewsInventory(result.value.value, {
		cwd: result.value.process.cwd,
		cdsLib: result.value.cdsLib,
		workDir: request.workDir,
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		...finalized.value,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
	});
}

export interface InspectVirtuosoCellViewRequest extends VirtuosoBridgeOptions {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function inspectVirtuosoSchematic(
	request: InspectVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoInspectionResult<VirtuosoSchematicInspectSummary> | VirtuosoInspectionDryRunResult>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const schematicInspectPath = join(dirname(bridgePath), "schematic-inspect.il");
	const result = await runVirtuosoBridgeExpression<unknown>({
		...request,
		expression: `load(${skillString(schematicInspectPath)})\nvaInspectSchematic(${skillString(
			request.library,
		)} ${skillString(request.cell)} ${skillString(request.view)})`,
	});
	if (!result.ok) {
		return result;
	}
	if (result.value.process.dryRun) {
		return ok({
			inspection: "dry-run",
			target: { library: request.library, cell: request.cell, view: request.view },
			process: result.value.process,
			scriptPath: result.value.scriptPath,
			bridgePath: result.value.bridgePath,
			cdsLib: result.value.cdsLib,
		});
	}
	const finalized = await finalizeSchematicInspection({
		raw: result.value.value,
		target: { library: request.library, cell: request.cell, view: request.view },
		artifactContext: {
			cwd: result.value.process.cwd,
			cdsLib: result.value.cdsLib,
			workDir: request.workDir,
		},
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		inspection: "completed",
		...finalized.value,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
	});
}

export async function inspectVirtuosoMaestro(
	request: InspectVirtuosoCellViewRequest,
): Promise<RuntimeResult<VirtuosoInspectionResult<VirtuosoMaestroInspectSummary> | VirtuosoInspectionDryRunResult>> {
	const bridgePath = request.bridgePath ?? getDefaultVirtuosoBridgePath();
	const maestroInspectPath = join(dirname(bridgePath), "maestro-inspect.il");
	const result = await runVirtuosoBridgeExpression<unknown>({
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
			inspection: "dry-run",
			target: { library: request.library, cell: request.cell, view: request.view },
			process: result.value.process,
			scriptPath: result.value.scriptPath,
			bridgePath: result.value.bridgePath,
			cdsLib: result.value.cdsLib,
		});
	}
	const finalized = await finalizeMaestroInspection({
		raw: result.value.value,
		target: { library: request.library, cell: request.cell, view: request.view },
		artifactContext: {
			cwd: result.value.process.cwd,
			cdsLib: result.value.cdsLib,
			workDir: request.workDir,
		},
		additionalWarnings:
			result.value.process.exitCode === 0
				? []
				: [
						`Virtuoso returned a complete manifest but did not exit cleanly (exitCode: ${result.value.process.exitCode}).`,
					],
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		inspection: "completed",
		...finalized.value,
		process: result.value.process,
		scriptPath: result.value.scriptPath,
		bridgePath: result.value.bridgePath,
		cdsLib: result.value.cdsLib,
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

export { normalizeSchematicInspect, summarizeSchematicInspect } from "./inspection-results.ts";
