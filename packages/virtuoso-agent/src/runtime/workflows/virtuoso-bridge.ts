import { join } from "node:path";
import {
	enqueueVirtuosoBridgeSessionCommand,
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
import type { ArtifactRef, CellViewRef } from "../core/inspection.ts";
import type { ProcessExecutor, ProcessRunResult } from "../core/process-runner.ts";
import { ok, type RuntimeResult } from "../core/result.ts";
import { finalizeVirtuosoLibrariesInventory, finalizeVirtuosoLibraryCellViewsInventory } from "./inventory-results.ts";

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
	kind: "libraries" | "cellviews";
}

export interface VirtuosoInventoryArtifactResult<TSummary> {
	summary?: TSummary;
	artifact?: VirtuosoInventoryArtifact;
	process: ProcessRunResult;
	scriptPath: string;
	bridgePath: string;
	cdsLib?: string;
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
