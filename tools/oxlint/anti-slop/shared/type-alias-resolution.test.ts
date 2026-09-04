import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "@babel/parser";

import type { ESTree } from "@oxlint/plugins";

import {
	createTypeAliasEnvironment,
	resolvedTypeMatches,
} from "./type-alias-resolution.ts";
import type { TypeAliasEnvironment } from "./type-alias-resolution.ts";

// Oxlint's ESTree uses `TSTypeReference.typeArguments` (a `TSTypeParameterInstantiation`)
// and `TSTypeParameter.name` (an `Identifier`). Babel emits the same nodes but names the
// reference-instantiation field `typeParameters` and stores the parameter name as a bare
// string. `buildEnvironment` parses with Babel, rewrites those two fields to oxlint's
// shape, and links `.parent` so lexical-scope walks (`enclosingTypeScope`,
// `ancestorDistance`, `lexicalTypeParameterNames`) see a connected tree.
const VISITOR_KEYS: Readonly<Record<string, readonly string[]>> = {
	Program: ["body"],
	TSTypeAliasDeclaration: ["id", "typeParameters", "typeAnnotation"],
	TSTypeParameterDeclaration: ["params"],
	TSTypeParameter: ["name", "constraint", "default"],
	TSTypeReference: ["typeName", "typeArguments"],
	TSTypeParameterInstantiation: ["params"],
	TSParenthesizedType: ["typeAnnotation"],
	TSUnionType: ["types"],
};

const SKIP_KEYS = new Set([
	"parent",
	"loc",
	"start",
	"end",
	"range",
	"extra",
	"leadingComments",
	"trailingComments",
	"innerComments",
]);

function normalizeAndLink(node: unknown, parent: unknown): void {
	if (node === null || typeof node !== "object") return;
	const value = node as Record<string, unknown> & { type?: string };
	value.parent = parent;
	if (value.type === "TSTypeReference" && "typeParameters" in value) {
		value.typeArguments = value.typeParameters;
		delete value.typeParameters;
	}
	if (value.type === "TSTypeParameter" && typeof value.name === "string") {
		value.name = { type: "Identifier", name: value.name } as unknown;
	}
	for (const key of Object.keys(value)) {
		if (SKIP_KEYS.has(key)) continue;
		const child = value[key];
		if (child !== null && typeof child === "object" && "type" in child) {
			normalizeAndLink(child, value);
			continue;
		}
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item !== null && typeof item === "object" && "type" in item) {
					normalizeAndLink(item, value);
				}
			}
		}
	}
}

function buildEnvironment(source: string): TypeAliasEnvironment {
	const parsed = parse(source, {
		plugins: ["typescript"],
		sourceType: "module",
		tokens: false,
		ranges: false,
	});
	normalizeAndLink(parsed.program, null);
	return createTypeAliasEnvironment(parsed.program, VISITOR_KEYS);
}

function aliasByName(environment: TypeAliasEnvironment, name: string) {
	return environment.aliases.find((alias) => alias.id.name === name) ?? null;
}

// Mirrors the `no-unknown-type-aliases` rule's matcher exactly: a resolved type hides
// `unknown` when it is (or contains, through parens/unions) a `TSUnknownKeyword`.
function resolvesToUnknown(type: ESTree.TSType, environment: TypeAliasEnvironment): boolean {
	return resolvedTypeMatches(type, environment, (resolved, matches) => {
		if (resolved.type === "TSUnknownKeyword") return true;
		if (resolved.type === "TSParenthesizedType") {
			return matches(resolved.typeAnnotation);
		}
		return resolved.type === "TSUnionType" && resolved.types.some(matches);
	});
}

function resolvesToUnknownName(environment: TypeAliasEnvironment, name: string): boolean {
	const alias = aliasByName(environment, name);
	assert.ok(alias !== null, `expected a type alias named ${name}`);
	return resolvesToUnknown(alias.typeAnnotation, environment);
}

test("a default referencing a module alias resolves in the alias declaration scope", () => {
	const envSafe = buildEnvironment(
		"type URI = string;\ntype Result<T = URI> = T;\ntype Safe = Result;\n",
	);
	assert.equal(resolvesToUnknownName(envSafe, "Safe"), false, "Result defaults to URI = string");
	const envUnsafe = buildEnvironment(
		"type URI = unknown;\ntype Result<T = URI> = T;\ntype Unsafe = Result;\n",
	);
	assert.equal(
		resolvesToUnknownName(envUnsafe, "Unsafe"),
		true,
		"Result defaults to URI = unknown",
	);
});

test("caller type-parameter bindings do not leak into a default's resolution (false-positive direction)", () => {
	// `tsc --strict` proves X = string here: Wrap's parameter is named `Untyped` (shadowing the
	// module alias) and an inner alias `Resp` has the default `T = Untyped`. The default must
	// resolve `Untyped` to the module-level alias (= string), never to Wrap's caller binding.
	const env = buildEnvironment(
		[
			"type Untyped = string;",
			"type Resp<T = Untyped> = T;",
			"type Wrap<Untyped = unknown> = Resp;",
			"type X = Wrap<unknown>;",
		].join("\n"),
	);
	assert.equal(resolvesToUnknownName(env, "Untyped"), false);
	assert.equal(
		resolvesToUnknownName(env, "Resp"),
		false,
		"Resp's body is a bare type parameter",
	);
	assert.equal(
		resolvesToUnknownName(env, "Wrap"),
		false,
		"Wrap resolves to Resp's default = string",
	);
	assert.equal(
		resolvesToUnknownName(env, "X"),
		false,
		"X = string, must not be flagged",
	);
});

test("derived aliases hiding unknown are surfaced consistently (false-negative direction)", () => {
	// `tsc --strict` proves X = unknown here: the same leak, reversed, hides the `unknown`
	// reaching `X`. The fix leaks nothing, so `Resp`'s default resolves `Untyped` to the
	// module alias = unknown and `X` is correctly flagged alongside its root causes.
	const env = buildEnvironment(
		[
			"type Untyped = unknown;",
			"type Resp<T = Untyped> = T;",
			"type Wrap<Untyped> = Resp;",
			"type X = Wrap<string>;",
		].join("\n"),
	);
	assert.equal(resolvesToUnknownName(env, "Untyped"), true);
	assert.equal(
		resolvesToUnknownName(env, "Wrap"),
		true,
		"Wrap resolves to Resp's default = unknown",
	);
	assert.equal(
		resolvesToUnknownName(env, "X"),
		true,
		"X = unknown must be flagged (was missed before the fix)",
	);
});

test("chained defaults see earlier parameters of the same alias", () => {
	// `type Chain<P = unknown, Q = P> = Q; type X = Chain;` resolves to `P` = unknown, so
	// `X` must be flagged. This only holds if a default's scope carries the alias's own
	// earlier parameters (declaration order), which the fix preserves via `defaultNext`.
	const env = buildEnvironment("type Chain<P = unknown, Q = P> = Q;\ntype X = Chain;\n");
	assert.equal(
		resolvesToUnknownName(env, "Chain"),
		false,
		"Chain's body is a bare type parameter",
	);
	assert.equal(
		resolvesToUnknownName(env, "X"),
		true,
		"chained default Q = P must substitute P before flagging X",
	);
});
