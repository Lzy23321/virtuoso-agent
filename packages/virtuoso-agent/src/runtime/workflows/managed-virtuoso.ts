import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { executeVirtuosoBridgeSessionCommand, skillString } from "../backends/virtuoso/bridge.ts";
import {
	type LiveManagedVirtuosoInstance,
	listManagedVirtuosoInstances,
	resolveManagedVirtuosoInstance,
} from "../backends/virtuoso/instance-registry.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import type {
	VirtuosoCellViewRef,
	VirtuosoInventoryArtifact,
	VirtuosoInventoryCellViewsSummary,
	VirtuosoInventoryLibrariesSummary,
	VirtuosoInventoryLibrary,
	VirtuosoInventoryLibrarySummary,
	VirtuosoMaestroInspect,
	VirtuosoMaestroInspectSummary,
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
}

export interface ManagedShowCellViewRequest extends ManagedVirtuosoRequest {
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
	const summary = {
		counts: result.value.value.counts,
		libraries: result.value.value.libraries.map(summarizeInventoryLibrary),
	};
	return writeManagedArtifact(
		result.value.instance,
		"libraries",
		"inventory",
		"libraries",
		result.value.value,
		summary,
	);
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
	const summary = { library: summarizeInventoryLibrary(result.value.value) };
	return writeManagedArtifact(
		result.value.instance,
		"cellviews",
		"inventory",
		`cellviews-${request.library}`,
		result.value.value,
		summary,
	);
}

export async function inspectManagedVirtuosoMaestro(
	request: ManagedVirtuosoRequest & { library: string; cell: string; view: string },
): Promise<RuntimeResult<ManagedVirtuosoArtifactResult<VirtuosoMaestroInspectSummary>>> {
	const result = await executeManagedOperation<VirtuosoMaestroInspect>(request, false, (resultPath, instance) => {
		const inspectPath = join(dirname(instance.bridgePath), "maestro-inspect.il");
		return `load(${skillString(inspectPath)})\nvaSessionInspectMaestro(${skillString(request.library)} ${skillString(
			request.cell,
		)} ${skillString(request.view)} ${skillString(resultPath)})`;
	});
	if (!result.ok) {
		return result;
	}
	const full: VirtuosoMaestroInspect = {
		...result.value.value,
		generatedAt: new Date().toISOString(),
		source: {
			...result.value.value.source,
			...(result.value.instance.cdsLib ? { cdsLib: result.value.instance.cdsLib } : {}),
		},
	};
	const summary: VirtuosoMaestroInspectSummary = {
		kind: full.kind,
		target: full.target,
		session: {
			name: full.session.name,
			valid: full.session.valid,
			singleTest: full.session.singleTest,
			closedAfterInspect: full.session.closedAfterInspect,
		},
		counts: full.summary,
	};
	return writeManagedArtifact(
		result.value.instance,
		"maestro-inspect",
		"inspect",
		`maestro-${request.library}-${request.cell}-${request.view}`,
		full,
		summary,
	);
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

async function writeManagedArtifact<TSummary>(
	instance: LiveManagedVirtuosoInstance,
	kind: VirtuosoInventoryArtifact["kind"],
	directoryName: "inventory" | "inspect",
	name: string,
	full: unknown,
	summary: TSummary,
): Promise<RuntimeResult<ManagedVirtuosoArtifactResult<TSummary>>> {
	const createdAt = new Date().toISOString();
	const baseDir = instance.cdsLib ? dirname(resolve(instance.cdsLib)) : instance.cwd;
	const directory = join(baseDir, ".virtuoso-agent", directoryName);
	const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
	const timestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const path = join(directory, `${safeName}-${timestamp}.json`);
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, "utf8");
		return ok({ instance, summary, artifact: { path, format: "json", kind, createdAt } });
	} catch (error) {
		return fail({
			type: "virtuoso_artifact_write_error",
			stage: "virtuoso_artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { path, kind },
		});
	}
}

function summarizeInventoryLibrary(library: VirtuosoInventoryLibrarySummary): VirtuosoInventoryLibrarySummary {
	return { name: library.name, path: library.path, counts: library.counts };
}
