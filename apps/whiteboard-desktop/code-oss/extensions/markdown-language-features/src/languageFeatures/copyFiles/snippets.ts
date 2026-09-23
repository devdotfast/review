/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resolves variables in a VS Code snippet style string
 */
export function resolveSnippet(snippetString: string, vars: ReadonlyMap<string, string>): string {
	let result = '';
	let cursor = 0;
	while (cursor < snippetString.length) {
		if (snippetString[cursor] === '\\' && snippetString[cursor + 1] === '$') {
			result += '$';
			cursor += 2;
			continue;
		}

		const variable = snippetString[cursor] === '$'
			? parseVariable(snippetString, cursor)
			: undefined;
		if (!variable) {
			result += snippetString[cursor++];
			continue;
		}

		const original = snippetString.slice(cursor, variable.end);
		const entry = vars.get(variable.name);
		if (typeof entry !== 'string') {
			result += original;
		} else if (variable.pattern !== undefined && variable.replacement !== undefined) {
			result += entry.replace(
				new RegExp(replaceTransformEscapes(variable.pattern)),
				replaceTransformEscapes(variable.replacement),
			);
		} else {
			result += entry;
		}
		cursor = variable.end;
	}
	return result;
}

interface ParsedVariable {
	readonly end: number;
	readonly name: string;
	readonly pattern?: string;
	readonly replacement?: string;
}

function parseVariable(source: string, start: number): ParsedVariable | undefined {
	if (source[start + 1] !== '{') {
		return undefined;
	}

	let cursor = start + 2;
	const nameStart = cursor;
	while (cursor < source.length && isVariableNameCharacter(source.charCodeAt(cursor))) {
		cursor++;
	}
	if (cursor === nameStart) {
		return undefined;
	}

	const name = source.slice(nameStart, cursor);
	if (source[cursor] === '}') {
		return { end: cursor + 1, name };
	}
	if (source[cursor] !== '/') {
		return undefined;
	}

	const patternStart = ++cursor;
	while (cursor < source.length) {
		if (source[cursor] === '}') {
			return undefined;
		}
		if (source[cursor] === '\\' && source[cursor + 1] === '/') {
			cursor += 2;
			continue;
		}
		if (source[cursor] === '/') {
			break;
		}
		cursor++;
	}
	if (cursor === patternStart || source[cursor] !== '/') {
		return undefined;
	}

	const pattern = source.slice(patternStart, cursor);
	const replacementStart = ++cursor;
	while (cursor < source.length) {
		if (source[cursor] === '}') {
			return undefined;
		}
		if (source[cursor] === '\\' && source[cursor + 1] === '/') {
			cursor += 2;
			continue;
		}
		if (source[cursor] === '/' && source[cursor + 1] === '}') {
			if (cursor === replacementStart) {
				return undefined;
			}
			return {
				end: cursor + 2,
				name,
				pattern,
				replacement: source.slice(replacementStart, cursor),
			};
		}
		cursor++;
	}
	return undefined;
}

function isVariableNameCharacter(code: number): boolean {
	return code >= 48 && code <= 57
		|| code >= 65 && code <= 90
		|| code === 95
		|| code >= 97 && code <= 122;
}

function replaceTransformEscapes(str: string): string {
	return str.replaceAll('\\/', '/');
}
