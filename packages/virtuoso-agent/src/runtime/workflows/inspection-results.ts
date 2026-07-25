import { dirname, join, resolve } from "node:path";
import type { CellViewRef, InspectResult } from "../core/inspection.ts";
import { writeJsonArtifact } from "../core/json-artifact.ts";
import { ok, type RuntimeResult } from "../core/result.ts";
import { validateVirtuosoMaestroInspect, validateVirtuosoSchematicInspect } from "./manifest-validation.ts";
import { selectSchematicAgentParameters } from "./schematic-parameters.ts";
import { writeSchematicTopologyArtifact } from "./schematic-topology.ts";
import type {
	VirtuosoInventoryArtifact,
	VirtuosoInventoryCellViewsSummary,
	VirtuosoInventoryLibrariesSummary,
	VirtuosoInventoryLibrary,
	VirtuosoInventoryLibrarySummary,
	VirtuosoMaestroInspect,
	VirtuosoMaestroInspectSummary,
	VirtuosoSchematicConnection,
	VirtuosoSchematicCounts,
	VirtuosoSchematicInspect,
	VirtuosoSchematicInspectSummary,
	VirtuosoSchematicMaster,
	VirtuosoSchematicReference,
} from "./virtuoso-bridge.ts";

export interface VirtuosoArtifactContext {
	cwd: string;
	cdsLib?: string;
	workDir?: string;
}

export interface FinalizedInventoryResult<TSummary> {
	summary: TSummary;
	artifact: VirtuosoInventoryArtifact;
}

export interface FinalizeInspectionRequest {
	raw: unknown;
	target: CellViewRef;
	artifactContext: VirtuosoArtifactContext;
	additionalWarnings?: string[];
}

export async function finalizeVirtuosoLibrariesInventory(
	full: VirtuosoInventoryLibrariesSummary,
	context: VirtuosoArtifactContext,
): Promise<RuntimeResult<FinalizedInventoryResult<VirtuosoInventoryLibrariesSummary>>> {
	return writeInventoryResult(
		full,
		{
			counts: full.counts,
			libraries: full.libraries.map(summarizeInventoryLibrary),
		},
		context,
		"libraries",
		"libraries",
	);
}

export async function finalizeVirtuosoLibraryCellViewsInventory(
	full: VirtuosoInventoryLibrary,
	context: VirtuosoArtifactContext,
): Promise<RuntimeResult<FinalizedInventoryResult<VirtuosoInventoryCellViewsSummary>>> {
	return writeInventoryResult(
		full,
		{ library: summarizeInventoryLibrary(full) },
		context,
		"cellviews",
		`cellviews-${full.name}`,
	);
}

export async function finalizeSchematicInspection(
	request: FinalizeInspectionRequest,
): Promise<RuntimeResult<InspectResult<VirtuosoSchematicInspectSummary>>> {
	const validated = validateVirtuosoSchematicInspect(request.raw, request.target);
	if (!validated.ok) {
		return validated;
	}
	const full = normalizeSchematicInspect(validated.value, request.artifactContext.cdsLib);
	const artifact = await writeJsonArtifact({
		directory: resolveVirtuosoArtifactDirectory(request.artifactContext, "inspect"),
		kind: "schematic-inspect",
		name: `schematic-${request.target.library}-${request.target.cell}-${request.target.view}`,
		value: full,
	});
	if (!artifact.ok) {
		return artifact;
	}
	const topology = await writeSchematicTopologyArtifact(full, artifact.value);
	if (!topology.ok) {
		return topology;
	}
	return ok({
		target: full.target,
		summary: summarizeSchematicInspect(full),
		artifacts: [artifact.value, topology.value],
		warnings: full.warnings,
	});
}

export async function finalizeMaestroInspection(
	request: FinalizeInspectionRequest,
): Promise<RuntimeResult<InspectResult<VirtuosoMaestroInspectSummary>>> {
	const validated = validateVirtuosoMaestroInspect(request.raw, request.target);
	if (!validated.ok) {
		return validated;
	}
	const full: VirtuosoMaestroInspect = {
		...validated.value,
		generatedAt: new Date().toISOString(),
		source: {
			...validated.value.source,
			...(request.artifactContext.cdsLib ? { cdsLib: request.artifactContext.cdsLib } : {}),
		},
		warnings: [...new Set([...validated.value.warnings, ...(request.additionalWarnings ?? [])])],
	};
	const artifact = await writeJsonArtifact({
		directory: resolveVirtuosoArtifactDirectory(request.artifactContext, "inspect"),
		kind: "maestro-inspect",
		name: `maestro-${request.target.library}-${request.target.cell}-${request.target.view}`,
		value: full,
	});
	if (!artifact.ok) {
		return artifact;
	}
	return ok({
		target: full.target,
		summary: summarizeMaestroInspect(full),
		artifacts: [artifact.value],
		warnings: full.warnings,
	});
}

export function normalizeSchematicInspect(
	inspect: VirtuosoSchematicInspect,
	cdsLib: string | undefined,
): VirtuosoSchematicInspect {
	const instances = inspect.instances
		.map((instance) => ({
			...instance,
			parameters: Object.fromEntries(
				Object.entries(instance.parameters).sort(([left], [right]) => left.localeCompare(right)),
			),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const terminals = [...inspect.terminals].sort((left, right) => left.name.localeCompare(right.name));
	const nets = [...inspect.nets].sort((left, right) => left.name.localeCompare(right.name));
	const connections = [...inspect.connections].sort((left, right) =>
		schematicConnectionKey(left).localeCompare(schematicConnectionKey(right)),
	);
	const referencesByMaster = new Map<string, VirtuosoSchematicReference>();
	for (const instance of instances) {
		const key = schematicMasterKey(instance.master);
		const existing = referencesByMaster.get(key);
		if (existing) {
			existing.instances.push(instance.name);
			existing.instanceCount += 1;
		} else {
			referencesByMaster.set(key, {
				master: instance.master,
				instanceCount: 1,
				instances: [instance.name],
			});
		}
	}
	const references = [...referencesByMaster.values()].sort((left, right) =>
		schematicMasterKey(left.master).localeCompare(schematicMasterKey(right.master)),
	);
	const instanceTerminalCount = connections.filter(
		(connection) => connection.endpoint.kind === "instance-terminal",
	).length;
	const connectedEndpointCount = connections.filter((connection) => connection.net !== null).length;
	const summary: VirtuosoSchematicCounts = {
		instances: instances.length,
		topTerminals: terminals.length,
		instanceTerminals: instanceTerminalCount,
		nets: nets.length,
		connectedEndpoints: connectedEndpointCount,
		unconnectedEndpoints: connections.length - connectedEndpointCount,
		referencedMasters: references.length,
	};
	const warnings = [...inspect.warnings];
	if (inspect.connectivity.status !== "clean") {
		warnings.push(`Schematic connectivity status is ${inspect.connectivity.status}.`);
	}
	if (summary.unconnectedEndpoints > 0) {
		warnings.push(`Schematic has ${summary.unconnectedEndpoints} unconnected endpoint(s).`);
	}
	return {
		...inspect,
		generatedAt: new Date().toISOString(),
		source: {
			...inspect.source,
			...(cdsLib ? { cdsLib } : {}),
		},
		summary,
		instances,
		terminals,
		nets,
		connections,
		references,
		warnings: [...new Set(warnings)],
	};
}

export function summarizeSchematicInspect(inspect: VirtuosoSchematicInspect): VirtuosoSchematicInspectSummary {
	return {
		kind: inspect.kind,
		connectivityStatus: inspect.connectivity.status,
		counts: inspect.summary,
		devices: inspect.references.map((reference) => ({
			master: { ...reference.master },
			count: reference.instanceCount,
			instances: [...reference.instances],
		})),
		instances: inspect.instances.map((instance) => ({
			name: instance.name,
			master: { ...instance.master },
			parameters: selectSchematicAgentParameters(instance.parameters),
		})),
	};
}

function summarizeMaestroInspect(inspect: VirtuosoMaestroInspect): VirtuosoMaestroInspectSummary {
	return {
		kind: inspect.kind,
		session: {
			name: inspect.session.name,
			valid: inspect.session.valid,
			singleTest: inspect.session.singleTest,
			closedAfterInspect: inspect.session.closedAfterInspect,
		},
		counts: inspect.summary,
	};
}

async function writeInventoryResult<TSummary>(
	full: unknown,
	summary: TSummary,
	context: VirtuosoArtifactContext,
	kind: "libraries" | "cellviews",
	name: string,
): Promise<RuntimeResult<FinalizedInventoryResult<TSummary>>> {
	const artifact = await writeJsonArtifact({
		directory: resolveVirtuosoArtifactDirectory(context, "inventory"),
		kind,
		name,
		value: full,
	});
	if (!artifact.ok) {
		return artifact;
	}
	return ok({ summary, artifact: artifact.value });
}

function summarizeInventoryLibrary(library: VirtuosoInventoryLibrarySummary): VirtuosoInventoryLibrarySummary {
	return {
		name: library.name,
		path: library.path,
		counts: library.counts,
	};
}

function resolveVirtuosoArtifactDirectory(context: VirtuosoArtifactContext, category: "inventory" | "inspect"): string {
	const baseDir = context.workDir ?? (context.cdsLib ? dirname(resolve(context.cdsLib)) : context.cwd);
	return join(resolve(baseDir), ".virtuoso-agent", category);
}

function schematicMasterKey(master: VirtuosoSchematicMaster): string {
	return `${master.library}/${master.cell}/${master.view}`;
}

function schematicConnectionKey(connection: VirtuosoSchematicConnection): string {
	const endpoint = connection.endpoint;
	return endpoint.kind === "instance-terminal"
		? `${endpoint.kind}/${endpoint.instance}/${endpoint.terminal}`
		: `${endpoint.kind}/${endpoint.terminal}`;
}
