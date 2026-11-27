import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isImportDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNoSubstitutionTemplateLiteral,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

// Bundled modules are vendored snapshots under src/modules/<name>. Each
// subtree keeps upstream ./x.js specifiers, outside this rule. The list
// must cover every vendored subtree; first-party modules stay checked.
const vendoredModulePaths = new Set([
	"packages/coding-agent/src/modules/ask-lite",
	"packages/coding-agent/src/modules/mcp-lite",
	"packages/coding-agent/src/modules/pi-btw",
	"packages/coding-agent/src/modules/pi-fake-codex",
	"packages/coding-agent/src/modules/pi-fake-opencode",
	"packages/coding-agent/src/modules/pi-git-tools",
	"packages/coding-agent/src/modules/pi-image",
	"packages/coding-agent/src/modules/pi-lsp-mini",
	"packages/coding-agent/src/modules/pi-meat",
	"packages/coding-agent/src/modules/pi-memory",
	"packages/coding-agent/src/modules/pi-output-compact",
	"packages/coding-agent/src/modules/pi-rewind",
	"packages/coding-agent/src/modules/pi-simplify",
	"packages/coding-agent/src/modules/pi-smart-flow",
	"packages/coding-agent/src/modules/pi-subagent-mini",
	"packages/coding-agent/src/modules/pi-token-usage",
	"packages/coding-agent/src/modules/pi-ui",
	"packages/coding-agent/src/modules/todo-lite",
	"packages/coding-agent/src/modules/tool-result-store",
	"packages/coding-agent/src/modules/websearch",
]);
const ignoredDirectories = new Set([".git", ".next", "coverage", "dist", "node_modules", "out"]);
const files = [];

function collectTypescriptFiles(directory) {
	if (vendoredModulePaths.has(directory.replaceAll("\\", "/"))) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectTypescriptFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isStringLiteralLike(node) {
	return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function getImportTypeSpecifier(node) {
	if (!isLiteralTypeNode(node.argument)) return undefined;
	if (!isStringLiteralLike(node.argument.literal)) return undefined;
	return node.argument.literal;
}

const failures = [];

collectTypescriptFiles(".");

// Parse every file through one synthetic project. noResolve keeps the program to exactly these files.
const configPath = resolve("tsconfig.check-ts-relative-imports.json");
const config = JSON.stringify({
	compilerOptions: { noResolve: true, noLib: true, types: [] },
	files: files.map((file) => resolve(file)),
});
const api = new API({
	cwd: process.cwd(),
	fs: {
		fileExists: (fileName) => (resolve(fileName) === configPath ? true : undefined),
		readFile: (fileName) => (resolve(fileName) === configPath ? config : undefined),
	},
});

try {
	const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
	for (const file of files.sort()) {
		const sourceFile = program.getSourceFile(resolve(file));

		function checkSpecifier(node) {
			if (!isRelativeJavaScriptSpecifier(node.text)) return;
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			failures.push(`${relative(".", file)}:${line + 1}:${character + 1}: ${node.text}`);
		}

		function visit(node) {
			if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
				checkSpecifier(node.moduleSpecifier);
			} else if (isExportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
				checkSpecifier(node.moduleSpecifier);
			} else if (
				isCallExpression(node) &&
				node.expression.kind === SyntaxKind.ImportKeyword &&
				isStringLiteralLike(node.arguments[0])
			) {
				checkSpecifier(node.arguments[0]);
			} else if (isImportTypeNode(node)) {
				const specifier = getImportTypeSpecifier(node);
				if (specifier) checkSpecifier(specifier);
			}

			node.forEachChild(visit);
		}

		visit(sourceFile);
	}
} finally {
	api.close();
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
