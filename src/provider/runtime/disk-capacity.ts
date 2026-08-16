import { statfs } from 'node:fs/promises';

const GIB = 1024 ** 3;
const MINIMUM_RESERVE_BYTES = 4 * GIB;
const DEFAULT_RESERVE_RATIO = 0.1;
const DEFAULT_ASSIGNMENT_HEADROOM_BYTES = 2 * GIB;

export type ProviderDiskCapacity = {
	ok: boolean;
	path: string;
	totalBytes: number;
	availableBytes: number;
	reserveBytes: number;
	assignmentHeadroomBytes: number;
	requiredAvailableBytes: number;
	deficitBytes: number;
	reason: string | null;
};

function configuredBytes(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function evaluateProviderDiskCapacity(input: {
	path: string;
	totalBytes: number;
	availableBytes: number;
	minimumReserveBytes?: number;
	assignmentHeadroomBytes?: number;
}): ProviderDiskCapacity {
	const proportionalReserve = Math.ceil(input.totalBytes * DEFAULT_RESERVE_RATIO);
	const reserveBytes = Math.max(MINIMUM_RESERVE_BYTES, proportionalReserve, input.minimumReserveBytes ?? 0);
	const assignmentHeadroomBytes = Math.max(0, input.assignmentHeadroomBytes ?? DEFAULT_ASSIGNMENT_HEADROOM_BYTES);
	const requiredAvailableBytes = reserveBytes + assignmentHeadroomBytes;
	const deficitBytes = Math.max(0, requiredAvailableBytes - input.availableBytes);
	return {
		ok: deficitBytes === 0,
		path: input.path,
		totalBytes: input.totalBytes,
		availableBytes: input.availableBytes,
		reserveBytes,
		assignmentHeadroomBytes,
		requiredAvailableBytes,
		deficitBytes,
		reason: deficitBytes === 0
			? null
			: `provider-disk-capacity-insufficient: ${input.availableBytes} bytes available; ${requiredAvailableBytes} required (${reserveBytes} reserve plus ${assignmentHeadroomBytes} assignment headroom)`,
	};
}

export async function observeProviderDiskCapacity(input: { path: string; env?: Record<string, string> }) {
	const env = input.env ?? {};
	const stats = await statfs(input.path, { bigint: true });
	return evaluateProviderDiskCapacity({
		path: input.path,
		totalBytes: Number(stats.blocks * stats.bsize),
		availableBytes: Number(stats.bavail * stats.bsize),
		minimumReserveBytes: configuredBytes(
			env.TREESEED_PROVIDER_MIN_FREE_DISK_BYTES ?? env.TREESEED_MIN_FREE_DISK_BYTES,
			0,
		),
		assignmentHeadroomBytes: configuredBytes(
			env.TREESEED_PROVIDER_ASSIGNMENT_DISK_HEADROOM_BYTES,
			DEFAULT_ASSIGNMENT_HEADROOM_BYTES,
		),
	});
}
