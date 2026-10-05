import type { Handler } from './contracts.ts';

export class HandlerRegistry {
	readonly #handlers = new Map<string, Handler>();

	constructor(handlers: Handler[]) {
		for (const handler of handlers) {
			if (this.#handlers.has(handler.id)) throw new Error(`duplicate_handler:${handler.id}`);
			this.#handlers.set(handler.id, handler);
		}
	}

	resolve(id: string): Handler {
		const handler = this.#handlers.get(id);
		if (!handler) throw new Error(`unknown_handler:${id}`);
		return handler;
	}

	describe(): Array<{ id: string }> {
		return [...this.#handlers.keys()].sort().map((id) => ({ id }));
	}
}
