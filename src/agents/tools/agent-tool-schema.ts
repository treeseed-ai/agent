export interface AgentToolSchemaValidationResult {
	ok: boolean;
	code?: 'invalid_tool_descriptor' | 'invalid_tool_input';
	message?: string;
	metadata?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function schemaType(schema: Record<string, unknown>) {
	return typeof schema.type === 'string' ? schema.type : '';
}

function validatePrimitive(value: unknown, schema: Record<string, unknown>, path: string): AgentToolSchemaValidationResult {
	const type = schemaType(schema);
	if (type === 'string') {
		if (typeof value !== 'string') return { ok: false, code: 'invalid_tool_input', message: `${path} must be a string.`, metadata: { path, expected: type } };
		const minimum = Number(schema.minLength);
		const maximum = Number(schema.maxLength);
		if (Number.isFinite(minimum) && value.length < minimum) return { ok: false, code: 'invalid_tool_input', message: `${path} must contain at least ${minimum} characters.`, metadata: { path, minLength: minimum } };
		if (Number.isFinite(maximum) && value.length > maximum) return { ok: false, code: 'invalid_tool_input', message: `${path} must contain at most ${maximum} characters.`, metadata: { path, maxLength: maximum } };
		return { ok: true };
	}
	if (type === 'boolean') {
		return typeof value === 'boolean'
			? { ok: true }
			: { ok: false, code: 'invalid_tool_input', message: `${path} must be a boolean.`, metadata: { path, expected: type } };
	}
	if (type === 'number') {
		return typeof value === 'number' && Number.isFinite(value)
			? { ok: true }
			: { ok: false, code: 'invalid_tool_input', message: `${path} must be a finite number.`, metadata: { path, expected: type } };
	}
	if (type === 'integer') {
		if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { ok: false, code: 'invalid_tool_input', message: `${path} must be a safe integer.`, metadata: { path, expected: type } };
		const minimum = Number(schema.minimum);
		const maximum = Number(schema.maximum);
		if (Number.isFinite(minimum) && value < minimum) return { ok: false, code: 'invalid_tool_input', message: `${path} must be at least ${minimum}.`, metadata: { path, minimum } };
		if (Number.isFinite(maximum) && value > maximum) return { ok: false, code: 'invalid_tool_input', message: `${path} must be at most ${maximum}.`, metadata: { path, maximum } };
		return { ok: true };
	}
	return {
		ok: false,
		code: 'invalid_tool_descriptor',
		message: `Unsupported schema type "${type}" at ${path}.`,
		metadata: { path, type },
	};
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string): AgentToolSchemaValidationResult {
	const type = schemaType(schema);
	if (type === 'object') {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { ok: false, code: 'invalid_tool_input', message: `${path} must be an object.`, metadata: { path, expected: type } };
		}
		const properties = record(schema.properties);
		const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
		const objectValue = record(value);
		for (const key of required) {
			if (!(key in objectValue)) {
				return {
					ok: false,
					code: 'invalid_tool_input',
					message: `Missing required tool input "${path}.${key}".`,
					metadata: { field: `${path}.${key}`, required },
				};
			}
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(objectValue)) {
				if (!(key in properties)) {
					return {
						ok: false,
						code: 'invalid_tool_input',
						message: `Unexpected tool input "${path}.${key}".`,
						metadata: { field: `${path}.${key}` },
					};
				}
			}
		}
		for (const [key, child] of Object.entries(objectValue)) {
			if (!(key in properties)) continue;
			const result = validateValue(child, record(properties[key]), `${path}.${key}`);
			if (!result.ok) return result;
		}
		return { ok: true };
	}
	if (type === 'array') {
		if (!Array.isArray(value)) {
			return { ok: false, code: 'invalid_tool_input', message: `${path} must be an array.`, metadata: { path, expected: type } };
		}
		const items = record(schema.items);
		const minimum = Number(schema.minItems);
		const maximum = Number(schema.maxItems);
		if (Number.isFinite(minimum) && value.length < minimum) return { ok: false, code: 'invalid_tool_input', message: `${path} requires at least ${minimum} items.`, metadata: { path, minItems: minimum } };
		if (Number.isFinite(maximum) && value.length > maximum) return { ok: false, code: 'invalid_tool_input', message: `${path} permits at most ${maximum} items.`, metadata: { path, maxItems: maximum } };
		const itemType = schemaType(items);
		if (!itemType) {
			return {
				ok: false,
				code: 'invalid_tool_descriptor',
				message: `Array schema at ${path} must declare an item type.`,
				metadata: { path },
			};
		}
		for (let index = 0; index < value.length; index += 1) {
			const result = itemType === 'object'
				? validateValue(value[index], items, `${path}[${index}]`)
				: validatePrimitive(value[index], items, `${path}[${index}]`);
			if (!result.ok) return result;
		}
		return { ok: true };
	}
	return validatePrimitive(value, schema, path);
}

export function validateAgentToolInput(
	schema: Record<string, unknown>,
	input: Record<string, unknown>,
): AgentToolSchemaValidationResult {
	if (schemaType(schema) !== 'object') {
		return {
			ok: false,
			code: 'invalid_tool_descriptor',
			message: 'Tool input schema must be an object schema.',
			metadata: { type: schema.type ?? null },
		};
	}
	const properties = record(schema.properties);
	const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
	for (const key of required) {
		if (!(key in input)) {
			return {
				ok: false,
				code: 'invalid_tool_input',
				message: `Missing required tool input "${key}".`,
				metadata: { field: key, required },
			};
		}
	}
	if (schema.additionalProperties === false) {
		for (const key of Object.keys(input)) {
			if (!(key in properties)) {
				return {
					ok: false,
					code: 'invalid_tool_input',
					message: `Unexpected tool input "${key}".`,
					metadata: { field: key },
				};
			}
		}
	}
	for (const [key, value] of Object.entries(input)) {
		if (!(key in properties)) continue;
		const result = validateValue(value, record(properties[key]), key);
		if (!result.ok) return result;
	}
	return { ok: true };
}
