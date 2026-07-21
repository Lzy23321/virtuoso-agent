export interface CompactAgentOutputOptions {
	includeProcessOutput?: boolean;
	maxInlineTextChars?: number;
}

interface ProcessOutputSummary {
	omitted: true;
	stdoutBytes: number;
	stderrBytes: number;
}

const DEFAULT_MAX_INLINE_TEXT_CHARS = 1200;

export function compactAgentOutput<TValue>(value: TValue, options: CompactAgentOutputOptions = {}): TValue {
	if (options.includeProcessOutput) {
		return value;
	}
	return compactValue(value, {
		maxInlineTextChars: options.maxInlineTextChars ?? DEFAULT_MAX_INLINE_TEXT_CHARS,
		seen: new WeakSet<object>(),
	}) as TValue;
}

function compactValue(value: unknown, context: { maxInlineTextChars: number; seen: WeakSet<object> }): unknown {
	if (typeof value === "string") {
		return compactLargeString(value, context.maxInlineTextChars);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	if (context.seen.has(value)) {
		return "[Circular]";
	}
	context.seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => compactValue(item, context));
	}

	if (isProcessRunResultLike(value)) {
		const { stdout, stderr, ...rest } = value as Record<string, unknown> & { stdout: string; stderr: string };
		return {
			...compactObject(rest, context),
			processOutput: summarizeProcessOutput(stdout, stderr),
		};
	}

	return compactObject(value as Record<string, unknown>, context);
}

function compactObject(value: Record<string, unknown>, context: { maxInlineTextChars: number; seen: WeakSet<object> }) {
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, context)]));
}

function isProcessRunResultLike(value: object): boolean {
	const record = value as Record<string, unknown>;
	return (
		Array.isArray(record.command) &&
		typeof record.cwd === "string" &&
		("exitCode" in record || record.exitCode === null) &&
		typeof record.stdout === "string" &&
		typeof record.stderr === "string" &&
		typeof record.startedAt === "string" &&
		typeof record.endedAt === "string" &&
		typeof record.dryRun === "boolean"
	);
}

function summarizeProcessOutput(stdout: string, stderr: string): ProcessOutputSummary {
	return {
		omitted: true,
		stdoutBytes: Buffer.byteLength(stdout, "utf8"),
		stderrBytes: Buffer.byteLength(stderr, "utf8"),
	};
}

function compactLargeString(value: string, maxInlineTextChars: number): unknown {
	if (value.length <= maxInlineTextChars) {
		return value;
	}
	return {
		omitted: true,
		bytes: Buffer.byteLength(value, "utf8"),
		chars: value.length,
	};
}
