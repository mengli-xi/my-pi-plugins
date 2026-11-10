#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
	createSourceFile,
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isNoSubstitutionTemplateLiteral,
	isStringLiteral,
	ScriptTarget,
	SyntaxKind,
} from "typescript";

const EXTENSION_PACKAGE_RE = /^@narumitw\/pi-/;
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const SOURCE_FILE_SUFFIXES = [
	".d.cts",
	".d.mts",
	".d.ts",
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
];

const packageJsonCache = new Map();
const resolvedLibraryCache = new Map();
const libraryCheckCache = new Map();
const rootDirectory = process.cwd();
const extensionPackage = {
	directory: rootDirectory,
	name: readJson(path.join(rootDirectory, "package.json")).name,
	packageJson: readJson(path.join(rootDirectory, "package.json")),
	packagePath: path.join(rootDirectory, "package.json"),
};
const failures = [];
checkPiEntrypoint(extensionPackage);
checkPackageDependencies(extensionPackage);
checkSourceImports(extensionPackage);

if (failures.length > 0) {
	console.error(`${extensionPackage.name} 包边界检查失败：`);
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`${extensionPackage.name} 单包边界检查通过`);
}

function checkLibraryPackage(libraryPackage) {
	const packagePath = fs.realpathSync(libraryPackage.packagePath);
	if (libraryCheckCache.has(packagePath)) return libraryCheckCache.get(packagePath);
	const previousFailureCount = failures.length;
	if (libraryPackage.packageJson.pi?.extensions !== undefined) {
		failures.push(
			`${relative(libraryPackage.packagePath)} libraries must not declare pi.extensions.`,
		);
	}
	if (!libraryPackage.packageJson.scripts?.build) {
		failures.push(`${relative(libraryPackage.packagePath)} libraries must define a build script.`);
	}
	if (!libraryPackage.packageJson.files?.includes("dist")) {
		failures.push(`${relative(libraryPackage.packagePath)} libraries must publish dist.`);
	}
	if (!String(libraryPackage.packageJson.main ?? "").startsWith("./dist/")) {
		failures.push(
			`${relative(libraryPackage.packagePath)} libraries must load JavaScript from dist.`,
		);
	}
	if (!String(libraryPackage.packageJson.types ?? "").startsWith("./dist/")) {
		failures.push(
			`${relative(libraryPackage.packagePath)} libraries must load declarations from dist.`,
		);
	}
	const valid = failures.length === previousFailureCount;
	libraryCheckCache.set(packagePath, valid);
	return valid;
}

function checkPiEntrypoint(extensionPackage) {
	const entrypoint = path.join(extensionPackage.directory, "src", "index.ts");
	if (!fs.existsSync(entrypoint)) {
		failures.push(`${relative(entrypoint)} must exist as the Pi extension entrypoint.`);
	}

	// Upstream pins this to "./src/index.ts" and lets pi transpile at load time.
	// A bundled entry is allowed here as well, but only when the package also
	// declares the build script that produces it — otherwise pi.extensions would
	// name a file nothing regenerates. src/index.ts still has to exist and still
	// has to be the only declared entry; this widens what may be pointed at, not
	// how many things may be. See LOCAL_PATCHES.md.
	const allowed = ["./src/index.ts"];
	if (extensionPackage.packageJson.scripts?.build) {
		allowed.push("./dist/index.js");
	}

	const entries = extensionPackage.packageJson.pi?.extensions;
	if (!Array.isArray(entries) || entries.length !== 1 || !allowed.includes(entries[0])) {
		failures.push(
			`${relative(extensionPackage.packagePath)} pi.extensions must be one of ${JSON.stringify(allowed)}.`,
		);
	}
}

function checkPackageDependencies(extensionPackage) {
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = extensionPackage.packageJson[field];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;

		for (const dependencyName of Object.keys(dependencies)) {
			if (!isForbiddenExtensionReference(extensionPackage, dependencyName)) continue;

			failures.push(
				`${relative(extensionPackage.packagePath)} ${field} must not reference ${dependencyName}.`,
			);
		}
	}
}

function checkSourceImports(extensionPackage) {
	const sourceDirectory = path.join(extensionPackage.directory, "src");
	if (!fs.existsSync(sourceDirectory)) return;

	for (const sourcePath of listSourceFiles(sourceDirectory)) {
		for (const specifier of moduleSpecifiers(sourcePath)) {
			if (!isForbiddenExtensionReference(extensionPackage, specifier, sourcePath)) continue;

			failures.push(`${relative(sourcePath)} must not import ${specifier}.`);
		}
	}
}

function listSourceFiles(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(entryPath));
			continue;
		}
		if (entry.isFile() && isSourceFile(entry.name)) files.push(entryPath);
	}
	return files.sort();
}

function isSourceFile(fileName) {
	return SOURCE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function moduleSpecifiers(sourcePath) {
	const sourceFile = createSourceFile(
		sourcePath,
		fs.readFileSync(sourcePath, "utf8"),
		ScriptTarget.Latest,
	);
	const specifiers = [];

	const visit = (node) => {
		if (isImportDeclaration(node) || isExportDeclaration(node)) {
			const specifier = node.moduleSpecifier && stringLiteralText(node.moduleSpecifier);
			if (specifier) specifiers.push(specifier);
		} else if (isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			const specifier = isExternalModuleReference(reference)
				? stringLiteralText(reference.expression)
				: undefined;
			if (specifier) specifiers.push(specifier);
		} else if (isCallExpression(node)) {
			const firstArgument = node.arguments[0];
			const specifier = firstArgument && stringLiteralText(firstArgument);
			if (specifier && isModuleLoaderCall(node)) specifiers.push(specifier);
		}

		node.forEachChild(visit);
	};

	visit(sourceFile);
	return specifiers;
}

function isModuleLoaderCall(node) {
	return (
		node.expression.kind === SyntaxKind.ImportKeyword ||
		(isIdentifier(node.expression) && node.expression.text === "require")
	);
}

function stringLiteralText(node) {
	return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isForbiddenExtensionReference(
	extensionPackage,
	specifier,
	fromPath = extensionPackage.packagePath,
) {
	const packageName = extensionPackage.name;
	if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return false;
	if (!EXTENSION_PACKAGE_RE.test(specifier)) return false;
	return !isResolvedLibrary(fromPath, specifier.split("/").slice(0, 2).join("/"));
}

function isResolvedLibrary(fromPath, packageName) {
	const cacheKey = `${path.dirname(fromPath)}\0${packageName}`;
	if (resolvedLibraryCache.has(cacheKey)) return resolvedLibraryCache.get(cacheKey);

	// Read metadata through Node's package search paths, not by loading the module.
	// Published libraries may hide package.json and expose only an import condition.
	const searchPaths = createRequire(fromPath).resolve.paths(packageName) ?? [];
	let valid = false;
	for (const searchPath of searchPaths) {
		const packagePath = path.join(searchPath, packageName, "package.json");
		if (!fs.existsSync(packagePath)) continue;
		const packageJson = readJson(packagePath);
		valid = packageJson.name === packageName && checkLibraryPackage({ packagePath, packageJson });
		break;
	}
	resolvedLibraryCache.set(cacheKey, valid);
	return valid;
}

function readJson(filePath) {
	const canonicalPath = fs.realpathSync(filePath);
	if (!packageJsonCache.has(canonicalPath)) {
		packageJsonCache.set(canonicalPath, JSON.parse(fs.readFileSync(canonicalPath, "utf8")));
	}
	return packageJsonCache.get(canonicalPath);
}

function relative(filePath) {
	return path.relative(rootDirectory, filePath) || filePath;
}
