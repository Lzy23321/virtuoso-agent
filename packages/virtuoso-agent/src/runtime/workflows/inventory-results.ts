import { dirname, join, resolve } from "node:path";
import { writeJsonArtifact } from "../core/json-artifact.ts";
import { ok, type RuntimeResult } from "../core/result.ts";
import type {
	VirtuosoInventoryArtifact,
	VirtuosoInventoryCellViewsSummary,
	VirtuosoInventoryLibrariesSummary,
	VirtuosoInventoryLibrary,
	VirtuosoInventoryLibrarySummary,
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

async function writeInventoryResult<TSummary>(
	full: unknown,
	summary: TSummary,
	context: VirtuosoArtifactContext,
	kind: "libraries" | "cellviews",
	name: string,
): Promise<RuntimeResult<FinalizedInventoryResult<TSummary>>> {
	const artifact = await writeJsonArtifact({
		directory: resolveVirtuosoInventoryDirectory(context),
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

function resolveVirtuosoInventoryDirectory(context: VirtuosoArtifactContext): string {
	const baseDir = context.workDir ?? (context.cdsLib ? dirname(resolve(context.cdsLib)) : context.cwd);
	return join(resolve(baseDir), ".virtuoso-agent", "inventory");
}
