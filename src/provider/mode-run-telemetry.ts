export interface AssignmentModeRunRecorder {
	createAssignmentModeRun(assignmentId: string, request: Record<string, unknown>): Promise<unknown>;
}

export interface ProviderModeRunTelemetryInput {
	recorder: AssignmentModeRunRecorder;
	assignmentId: string;
	eventId: string;
	request: Record<string, unknown>;
	maxAttempts?: number;
	timeoutMs?: number;
}

export class ProviderModeRunTelemetryError extends Error {
	readonly code = 'provider_mode_run_telemetry_delivery_failed';
	readonly retryable = true;
	readonly assignmentId: string;
	readonly eventId: string;
	readonly attempts: number;

	constructor(input: { assignmentId: string; eventId: string; attempts: number; cause: unknown }) {
		super(
			`Provider mode-run telemetry ${input.eventId} for assignment ${input.assignmentId} failed after ${input.attempts} attempts: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
			{ cause: input.cause },
		);
		this.name = 'ProviderModeRunTelemetryError';
		this.assignmentId = input.assignmentId;
		this.eventId = input.eventId;
		this.attempts = input.attempts;
	}
}

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} is required for provider mode-run telemetry.`);
	return normalized;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Provider mode-run telemetry value must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function safeId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'event';
}

export function providerModeRunTelemetryId(assignmentId: string, eventId: string): string {
	return `telemetry:${safeId(required(assignmentId, 'assignmentId'))}:${safeId(required(eventId, 'eventId'))}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function assertAccepted(result: unknown): void {
	if (result && typeof result === 'object' && !Array.isArray(result) && (result as Record<string, unknown>).ok === false) {
		throw new Error('Provider mode-run telemetry endpoint rejected the event.');
	}
}

export async function deliverProviderModeRunTelemetry(input: ProviderModeRunTelemetryInput): Promise<unknown> {
	const assignmentId = required(input.assignmentId, 'assignmentId');
	const eventId = required(input.eventId, 'eventId');
	const maxAttempts = boundedInteger(input.maxAttempts, 3, 1, 10);
	const timeoutMs = boundedInteger(input.timeoutMs, 10_000, 1, 60_000);
	const request = {
		...input.request,
		id: providerModeRunTelemetryId(assignmentId, eventId),
		metadata: {
			...((input.request.metadata && typeof input.request.metadata === 'object' && !Array.isArray(input.request.metadata))
				? input.request.metadata as Record<string, unknown>
				: {}),
			telemetryEventId: eventId,
		},
	};
	let lastError: unknown = new Error('Provider mode-run telemetry was not attempted.');
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const result = await withTimeout(
				input.recorder.createAssignmentModeRun(assignmentId, request),
				timeoutMs,
				`Provider mode-run telemetry ${eventId} exceeded ${timeoutMs}ms.`,
			);
			assertAccepted(result);
			return result;
		} catch (error) {
			lastError = error;
		}
	}
	throw new ProviderModeRunTelemetryError({ assignmentId, eventId, attempts: maxAttempts, cause: lastError });
}
