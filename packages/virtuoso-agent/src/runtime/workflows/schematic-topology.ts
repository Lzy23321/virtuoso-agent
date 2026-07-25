import { writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ArtifactRef } from "../core/inspection.ts";
import { fail, ok, type RuntimeResult } from "../core/result.ts";
import { selectSchematicAgentParameters } from "./schematic-parameters.ts";
import type {
	VirtuosoSchematicConnection,
	VirtuosoSchematicInspect,
	VirtuosoSchematicJsonValue,
} from "./virtuoso-bridge.ts";

export function renderSchematicTopology(inspect: VirtuosoSchematicInspect): string {
	const instanceConnections = new Map<string, VirtuosoSchematicConnection[]>();
	const topTerminalConnections = new Map<string, VirtuosoSchematicConnection[]>();
	for (const connection of inspect.connections) {
		const endpoint = connection.endpoint;
		const byEndpoint = endpoint.kind === "instance-terminal" ? instanceConnections : topTerminalConnections;
		const endpointName = endpoint.kind === "instance-terminal" ? endpoint.instance : endpoint.terminal;
		const existing = byEndpoint.get(endpointName);
		if (existing) {
			existing.push(connection);
		} else {
			byEndpoint.set(endpointName, [connection]);
		}
	}

	const lines = [
		"* virtuoso-agent schematic topology v1",
		"* Agent-readable connectivity view; not a simulator-ready netlist.",
		`* Target: ${inspect.target.library}/${inspect.target.cell}/${inspect.target.view}`,
		`* Connectivity: ${inspect.connectivity.status}`,
		`* Counts: instances=${inspect.summary.instances} terminals=${inspect.summary.topTerminals} nets=${inspect.summary.nets} unconnected=${inspect.summary.unconnectedEndpoints}`,
		"",
		`.cell ${formatToken(inspect.target.library)}/${formatToken(inspect.target.cell)}/${formatToken(inspect.target.view)}`,
		"",
		".terminals",
	];

	if (inspect.terminals.length === 0) {
		lines.push("  (none)");
	} else {
		for (const terminal of inspect.terminals) {
			const connections = topTerminalConnections.get(terminal.name) ?? [];
			const nets = [...new Set(connections.map((connection) => formatNet(connection.net)))];
			lines.push(
				`  ${formatToken(terminal.name)} direction=${formatToken(terminal.direction ?? "unknown")} width=${terminal.width} net=${nets.join(",") || "<unconnected>"}`,
			);
		}
	}

	const topologyInstances = inspect.instances.filter((instance) => {
		const connections = instanceConnections.get(instance.name) ?? [];
		return connections.length > 0 || Object.keys(instance.parameters).length > 0;
	});
	const omittedInstances = inspect.instances.length - topologyInstances.length;
	if (omittedInstances > 0) {
		lines.push("", `* Omitted ${omittedInstances} connectivity-free symbol instance(s).`);
	}

	lines.push("", ".instances");
	if (topologyInstances.length === 0) {
		lines.push("  (none)");
	} else {
		for (const instance of topologyInstances) {
			const master = `${formatToken(instance.master.library)}/${formatToken(instance.master.cell)}/${formatToken(instance.master.view)}`;
			lines.push(`  ${formatToken(instance.name)} master=${master}`);
			const connections = [...(instanceConnections.get(instance.name) ?? [])].sort((left, right) => {
				const leftTerminal = left.endpoint.kind === "instance-terminal" ? left.endpoint.terminal : "";
				const rightTerminal = right.endpoint.kind === "instance-terminal" ? right.endpoint.terminal : "";
				return leftTerminal.localeCompare(rightTerminal);
			});
			const pins = connections.map((connection) => {
				const endpoint = connection.endpoint;
				return endpoint.kind === "instance-terminal"
					? `${formatPinName(endpoint.terminal)}=${formatNet(connection.net)}`
					: "";
			});
			lines.push(`    pins ${pins.filter(Boolean).join(" ") || "(none)"}`);
			const parameters = Object.entries(selectSchematicAgentParameters(instance.parameters))
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, value]) => `${formatToken(name)}=${formatValue(value)}`);
			if (parameters.length > 0) {
				lines.push(`    params ${parameters.join(" ")}`);
			}
		}
	}

	lines.push("", ".ends", "");
	return lines.join("\n");
}

export async function writeSchematicTopologyArtifact(
	inspect: VirtuosoSchematicInspect,
	manifestArtifact: ArtifactRef,
): Promise<RuntimeResult<ArtifactRef>> {
	const manifestBaseName = basename(manifestArtifact.path, extname(manifestArtifact.path));
	const topologyBaseName = manifestBaseName.startsWith("schematic-")
		? `schematic-topology-${manifestBaseName.slice("schematic-".length)}`
		: `${manifestBaseName}-topology`;
	const path = join(dirname(manifestArtifact.path), `${topologyBaseName}.net`);
	try {
		await writeFile(path, renderSchematicTopology(inspect), "utf8");
		return ok({
			kind: "schematic-topology",
			format: "text",
			path,
			createdAt: manifestArtifact.createdAt,
		});
	} catch (error) {
		return fail({
			type: "artifact_write_error",
			stage: "artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { path, kind: "schematic-topology" },
		});
	}
}

function formatNet(net: string | null): string {
	return net === null ? "<unconnected>" : formatToken(net);
}

function formatValue(value: VirtuosoSchematicJsonValue): string {
	if (typeof value === "string") {
		return formatToken(value);
	}
	return JSON.stringify(value);
}

function formatToken(value: string): string {
	return /^[A-Za-z0-9_.$:+*/^()!<>=?@-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatPinName(value: string): string {
	return /^[A-Za-z0-9_.$:+*/^()<>?@-]+$/.test(value) ? value : JSON.stringify(value);
}
