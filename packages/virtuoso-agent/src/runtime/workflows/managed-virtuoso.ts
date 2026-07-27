import { executeVirtuosoBridgeSessionCommand, skillString } from "../backends/virtuoso/bridge.ts";
import {
	type LiveManagedVirtuosoInstance,
	listManagedVirtuosoInstances,
	resolveManagedVirtuosoInstance,
} from "../backends/virtuoso/instance-registry.ts";
import { ok, type RuntimeResult } from "../core/result.ts";
import { finalizeVirtuosoLibrariesInventory, finalizeVirtuosoLibraryCellViewsInventory } from "./inventory-results.ts";
import type {
	VirtuosoCellViewRef,
	VirtuosoInventoryArtifact,
	VirtuosoInventoryCellViewsSummary,
	VirtuosoInventoryLibrariesSummary,
	VirtuosoInventoryLibrary,
} from "./virtuoso-bridge.ts";

export interface ManagedVirtuosoRequest {
	instanceId?: string;
	cdsLib?: string;
	registryDir?: string;
	timeoutMs?: number;
}

export interface ManagedVirtuosoOperationResult<TValue> {
	instance: LiveManagedVirtuosoInstance;
	value: TValue;
	commandPath: string;
	resultPath: string;
	completedAt: string;
}

export interface ManagedVirtuosoArtifactResult<TSummary> {
	instance: LiveManagedVirtuosoInstance;
	summary: TSummary;
	artifact: VirtuosoInventoryArtifact;
	commandPath: string;
	resultPath: string;
	completedAt: string;
}

export interface ManagedShowCellViewRequest extends ManagedVirtuosoRequest {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export interface ManagedCellViewRequest extends ManagedVirtuosoRequest {
	library: string;
	cell: string;
	view: string;
	mode?: "r" | "a" | "w";
}

export async function getManagedVirtuosoInstances(
	request: Pick<ManagedVirtuosoRequest, "registryDir"> = {},
): Promise<RuntimeResult<LiveManagedVirtuosoInstance[]>> {
	return listManagedVirtuosoInstances({ registryDir: request.registryDir });
}

export async function getManagedCurrentCellView(
	request: ManagedVirtuosoRequest,
): Promise<RuntimeResult<ManagedVirtuosoOperationResult<VirtuosoCellViewRef>>> {
	return executeManagedOperation(
		request,
		true,
		(resultPath) => `vaSessionGetCurrentCellView(${skillString(resultPath)})`,
	);
}

export async function listManagedVirtuosoLibraries(
	request: ManagedVirtuosoRequest,
): Promise<RuntimeResult<ManagedVirtuosoArtifactResult<VirtuosoInventoryLibrariesSummary>>> {
	const result = await executeManagedOperation<VirtuosoInventoryLibrariesSummary>(
		request,
		false,
		(resultPath) => `vaSessionListLibraries(${skillString(resultPath)})`,
	);
	if (!result.ok) {
		return result;
	}
	const finalized = await finalizeVirtuosoLibrariesInventory(result.value.value, {
		cwd: result.value.instance.cwd,
		cdsLib: result.value.instance.cdsLib,
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		instance: result.value.instance,
		...finalized.value,
		commandPath: result.value.commandPath,
		resultPath: result.value.resultPath,
		completedAt: result.value.completedAt,
	});
}

export async function listManagedVirtuosoLibraryCellViews(
	request: ManagedVirtuosoRequest & { library: string },
): Promise<RuntimeResult<ManagedVirtuosoArtifactResult<VirtuosoInventoryCellViewsSummary>>> {
	const result = await executeManagedOperation<VirtuosoInventoryLibrary>(
		request,
		false,
		(resultPath) => `vaSessionListCellViews(${skillString(request.library)} ${skillString(resultPath)})`,
	);
	if (!result.ok) {
		return result;
	}
	const finalized = await finalizeVirtuosoLibraryCellViewsInventory(result.value.value, {
		cwd: result.value.instance.cwd,
		cdsLib: result.value.instance.cdsLib,
	});
	if (!finalized.ok) {
		return finalized;
	}
	return ok({
		instance: result.value.instance,
		...finalized.value,
		commandPath: result.value.commandPath,
		resultPath: result.value.resultPath,
		completedAt: result.value.completedAt,
	});
}

export async function showManagedVirtuosoCellView(
	request: ManagedShowCellViewRequest,
): Promise<RuntimeResult<ManagedVirtuosoOperationResult<VirtuosoCellViewRef & { visible: true }>>> {
	const mode = request.mode ?? "r";
	return executeManagedOperation(
		request,
		true,
		(resultPath) =>
			`vaSessionShowCellView(${skillString(request.library)} ${skillString(request.cell)} ${skillString(
				request.view,
			)} ${skillString(mode)} ${skillString(resultPath)})`,
	);
}

async function executeManagedOperation<TValue>(
	request: ManagedVirtuosoRequest,
	requireUi: boolean,
	expression: (resultPath: string, instance: LiveManagedVirtuosoInstance) => string,
): Promise<RuntimeResult<ManagedVirtuosoOperationResult<TValue>>> {
	const resolved = await resolveManagedVirtuosoInstance({
		registryDir: request.registryDir,
		instanceId: request.instanceId,
		cdsLib: request.cdsLib,
		requireUi,
	});
	if (!resolved.ok) {
		return resolved;
	}
	const executed = await executeVirtuosoBridgeSessionCommand<TValue>({
		sessionDir: resolved.value.sessionDir,
		heartbeatPath: resolved.value.heartbeatPath,
		expression: (resultPath) => expression(resultPath, resolved.value),
		timeoutMs: request.timeoutMs,
	});
	if (!executed.ok) {
		return executed;
	}
	return ok({
		instance: resolved.value,
		value: executed.value.value,
		commandPath: executed.value.commandPath,
		resultPath: executed.value.resultPath,
		completedAt: executed.value.completedAt,
	});
}
