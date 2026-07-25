import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef } from "./inspection.ts";
import { fail, ok, type RuntimeResult } from "./result.ts";

export interface JsonArtifactRef<TKind extends string = string> extends ArtifactRef {
	kind: TKind;
	format: "json";
}

export interface WriteJsonArtifactRequest<TKind extends string> {
	directory: string;
	kind: TKind;
	name: string;
	value: unknown;
}

export async function writeJsonArtifact<TKind extends string>(
	request: WriteJsonArtifactRequest<TKind>,
): Promise<RuntimeResult<JsonArtifactRef<TKind>>> {
	const createdAt = new Date().toISOString();
	const fileName = `${safeArtifactName(request.name)}-${formatArtifactTimestamp(createdAt)}-${randomUUID()}.json`;
	const path = join(request.directory, fileName);
	try {
		await mkdir(request.directory, { recursive: true });
		await writeFile(path, `${JSON.stringify(request.value, null, 2)}\n`, "utf8");
		return ok({
			kind: request.kind,
			format: "json",
			path,
			createdAt,
		});
	} catch (error) {
		return fail({
			type: "artifact_write_error",
			stage: "artifact_write",
			message: error instanceof Error ? error.message : String(error),
			details: { path, kind: request.kind },
		});
	}
}

function safeArtifactName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "artifact";
}

function formatArtifactTimestamp(value: string): string {
	return value.replace(/[-:]/g, "");
}
