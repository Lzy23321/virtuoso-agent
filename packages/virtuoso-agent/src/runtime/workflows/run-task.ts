import { fail, ok, type RuntimeResult } from "../core/result.ts";
import { validateTaskFile } from "../core/task-schema.ts";

export interface RunTaskResult {
	jobId: string;
	metrics: Record<string, number>;
	proposal: Array<{
		parameter: string;
		oldValue: string | number | boolean;
		newValue: string | number | boolean;
		reason: string;
	}>;
	artifacts: Record<string, string>;
}

export async function runTask(taskPath: string): Promise<RuntimeResult<RunTaskResult>> {
	const validation = await validateTaskFile(taskPath);
	if (!validation.ok) {
		return validation;
	}
	if (validation.value.issues.length > 0) {
		return fail({
			type: "task_schema_error",
			stage: "task_validation",
			message: "Task validation failed.",
			details: { issues: validation.value.issues },
		});
	}

	return ok({
		jobId: `fake_${Date.now()}`,
		metrics: {
			gain: 0.92,
		},
		proposal: [],
		artifacts: {
			report: "not-created-in-scaffold",
		},
	});
}
