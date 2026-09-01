import { request } from 'node:http';
import { createReadStream } from 'node:fs';
import type { SandboxAssignment, SandboxLeaseRenewal, SandboxResult } from '@treeseed/sdk/capacity-provider';

function call<T>(socketPath: string, method: string, path: string, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}) {
	return new Promise<T>((resolve, reject) => {
		const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		const operation = request({ socketPath, method, path, headers: { ...headers, ...(encoded ? { 'content-type': 'application/json', 'content-length': String(encoded.byteLength) } : {}) } }, (response) => {
			let value = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { value += chunk; });
			response.on('end', () => {
				let parsed: unknown; try { parsed = value ? JSON.parse(value) : {}; } catch { return reject(new Error('Sandbox broker returned invalid JSON.')); }
				if ((response.statusCode ?? 500) >= 400) return reject(new Error(String((parsed as Record<string, unknown>).error ?? `Sandbox broker returned ${response.statusCode}.`)));
				resolve(parsed as T);
			});
		});
		operation.once('error', reject); const abort = () => operation.destroy(new Error('Sandbox broker request aborted.'));
		if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
		operation.once('close', () => signal?.removeEventListener('abort', abort)); if (encoded) operation.write(encoded); operation.end();
	});
}

export class SandboxBrokerClient {
	constructor(readonly socketPath: string) {}
	private path(suffix: string) { return `/v${1}${suffix}`; }
	status(signal?: AbortSignal) { return call<Record<string, unknown>>(this.socketPath, 'GET', this.path('/status'), undefined, signal); }
	prepare(assignment: SandboxAssignment, signal?: AbortSignal) { return call<{ sandboxId: string; operationToken: string }>(this.socketPath, 'POST', this.path('/sandboxes'), { assignment }, signal); }
	upload(sandboxId: string, token: string, inputId: string, sourcePath: string, bytes: number, signal?: AbortSignal) {
		return new Promise<void>((resolve, reject) => {
			const operation = request({ socketPath: this.socketPath, method: 'PUT', path: this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/inputs/${encodeURIComponent(inputId)}`), headers: { authorization: `Bearer ${token}`, 'content-length': String(bytes), 'content-type': 'application/octet-stream' } }, (response) => {
				let value = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { value += chunk; }); response.on('end', () => (response.statusCode ?? 500) < 400 ? resolve() : reject(new Error(`Sandbox input upload failed: ${value.slice(0, 1_000)}`)));
			});
			operation.once('error', reject); const stream = createReadStream(sourcePath); stream.once('error', reject); stream.pipe(operation);
			if (signal) signal.addEventListener('abort', () => { stream.destroy(); operation.destroy(new Error('Sandbox input upload aborted.')); }, { once: true });
		});
	}
	execute(sandboxId: string, token: string, execution: Record<string, unknown>, signal?: AbortSignal) { return call<SandboxResult>(this.socketPath, 'POST', this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/execute`), { execution }, signal, { authorization: `Bearer ${token}` }); }
	nextToolRequest(sandboxId:string,token:string,signal?:AbortSignal){return call<{request:{id:string;tool:string;arguments:Record<string,unknown>}|null}>(this.socketPath,'GET',this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/tool-requests/next`),undefined,signal,{authorization:`Bearer ${token}`});}
	completeToolRequest(sandboxId:string,token:string,requestId:string,result:unknown,signal?:AbortSignal){return call<Record<string,unknown>>(this.socketPath,'POST',this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/tool-requests/${encodeURIComponent(requestId)}`),result,signal,{authorization:`Bearer ${token}`});}
	renew(sandboxId: string, token: string, renewal: SandboxLeaseRenewal) { return call<Record<string, unknown>>(this.socketPath, 'POST', this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/renew`), { renewal }, undefined, { authorization: `Bearer ${token}` }); }
	downloadArtifact(sandboxId: string, token: string, artifactId: string, expectedBytes: number, signal?: AbortSignal) {
		return new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = []; let bytes = 0;
			const operation = request({ socketPath: this.socketPath, method: 'GET', path: this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/artifacts/${encodeURIComponent(artifactId)}`), headers: { authorization: `Bearer ${token}` } }, (response) => {
				if ((response.statusCode ?? 500) >= 400) { response.resume(); return reject(new Error(`Sandbox artifact download failed with ${response.statusCode}.`)); }
				response.on('data', (chunk: Buffer) => { const value = Buffer.from(chunk); bytes += value.byteLength; if (bytes > expectedBytes) operation.destroy(new Error('Sandbox artifact exceeded its verified size.')); else chunks.push(value); });
				response.on('end', () => bytes === expectedBytes ? resolve(Buffer.concat(chunks)) : reject(new Error('Sandbox artifact size changed during collection.')));
			});
			operation.once('error', reject); if (signal) signal.addEventListener('abort', () => operation.destroy(new Error('Sandbox artifact download aborted.')), { once: true }); operation.end();
		});
	}
	cancel(sandboxId: string, token: string) { return call<Record<string, unknown>>(this.socketPath, 'POST', this.path(`/sandboxes/${encodeURIComponent(sandboxId)}/cancel`), undefined, undefined, { authorization: `Bearer ${token}` }); }
	destroy(sandboxId: string, token: string) { return call<Record<string, unknown>>(this.socketPath, 'DELETE', this.path(`/sandboxes/${encodeURIComponent(sandboxId)}`), undefined, undefined, { authorization: `Bearer ${token}` }); }
}
