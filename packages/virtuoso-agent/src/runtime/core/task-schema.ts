import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fail, ok, type RuntimeResult } from "./result.ts";

export interface TaskDocument {
	name: string;
	parameters?: Record<
		string,
		{
			value: string | number | boolean;
			min?: string | number;
			max?: string | number;
		}
	>;
	simulation?: {
		backend: "fake" | "ocean" | "spectre";
		script?: string;
	};
	outputs?: Array<{
		name: string;
		target?: string;
	}>;
	safety?: {
		allowWrite?: boolean;
		dryRun?: boolean;
	};
}

export interface TaskValidationIssue {
	path: string;
	message: string;
}

export interface TaskValidationResult {
	task: TaskDocument;
	issues: TaskValidationIssue[];
}

export function validateTaskObject(input: unknown): RuntimeResult<TaskValidationResult> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "Task must be an object.",
		});
	}

	const task = input as Partial<TaskDocument>;
	const issues: TaskValidationIssue[] = [];

	if (typeof task.name !== "string" || task.name.trim() === "") {
		issues.push({ path: "name", message: "Task name is required." });
	}

	if (task.simulation !== undefined) {
		if (!task.simulation || typeof task.simulation !== "object") {
			issues.push({ path: "simulation", message: "simulation must be an object." });
		} else if (!["fake", "ocean", "spectre"].includes(task.simulation.backend)) {
			issues.push({ path: "simulation.backend", message: "backend must be fake, ocean, or spectre." });
		}
	}

	if (task.outputs !== undefined && !Array.isArray(task.outputs)) {
		issues.push({ path: "outputs", message: "outputs must be an array." });
	}

	if (issues.length > 0) {
		return ok({ task: task as TaskDocument, issues });
	}

	return ok({ task: task as TaskDocument, issues });
}

export async function validateTaskFile(path: string): Promise<RuntimeResult<TaskValidationResult>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		return fail({
			type: "task_read_error",
			stage: "task_validation",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}

	if (extname(path) !== ".json") {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "The initial scaffold supports JSON task files only. YAML support will be added with the real parser.",
			details: { path },
		});
	}

	try {
		return validateTaskObject(JSON.parse(raw));
	} catch (error) {
		return fail({
			type: "task_parse_error",
			stage: "task_validation",
			message: error instanceof Error ? error.message : String(error),
			details: { path },
		});
	}
}
