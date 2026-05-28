export interface RuntimeError {
	type: string;
	message: string;
	stage?: string;
	details?: Record<string, unknown>;
}

export type RuntimeResult<T> =
	| {
			ok: true;
			value: T;
	  }
	| {
			ok: false;
			error: RuntimeError;
	  };

export function ok<T>(value: T): RuntimeResult<T> {
	return { ok: true, value };
}

export function fail<T = never>(error: RuntimeError): RuntimeResult<T> {
	return { ok: false, error };
}
