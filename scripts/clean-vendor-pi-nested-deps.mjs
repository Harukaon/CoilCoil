#!/usr/bin/env node
/**
 * Remove the dependency copies the root install leaves inside vendor/pi packages.
 *
 * CoilCoil depends on the vendored Pi packages through `file:` links, so a root
 * `npm ci` installs their devDependencies into `vendor/pi/packages/<pkg>/node_modules`
 * even though Pi's own install already hoisted the same packages to
 * `vendor/pi/node_modules`. Pi then type-checks against the nested copy, and the
 * duplicate `@types/node` breaks the global fetch types: `Response` resolves to an
 * empty type and `packages/agent/src/proxy.ts` fails to build. Pi is built from its
 * own tree, so remove same-version copies but keep package-specific versions that
 * differ from the Pi root (for example, newer SDKs required by upstream).
 */
import { readdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piRoot = join(repoRoot, "vendor", "pi");
const packagesDir = join(piRoot, "packages");
const piNodeModules = join(piRoot, "node_modules");

if (!existsSync(piNodeModules)) {
	// Pi has not been installed yet; its packages carry no nested copies to remove.
	process.exit(0);
}

const removed = [];
const preserved = [];
const readVersion = (packageJsonPath) => {
	try {
		return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
	} catch {
		return undefined;
	}
};

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const nested = join(packagesDir, entry.name, "node_modules");
	if (!existsSync(nested)) continue;

	for (const dependency of readdirSync(nested, { withFileTypes: true })) {
		if (dependency.name === ".bin") {
			rmSync(join(nested, dependency.name), { recursive: true, force: true });
			continue;
		}

		const dependencyPaths = dependency.name.startsWith("@")
			? readdirSync(join(nested, dependency.name), { withFileTypes: true }).map((child) => join(dependency.name, child.name))
			: [dependency.name];

		for (const dependencyPath of dependencyPaths) {
			const nestedPackage = join(nested, dependencyPath);
			const rootPackage = join(piNodeModules, dependencyPath);
			const nestedVersion = readVersion(join(nestedPackage, "package.json"));
			const rootVersion = readVersion(join(rootPackage, "package.json"));

			// Root npm installs can leave duplicate copies inside file-linked Pi
			// packages. Remove only exact duplicates; newer upstream dependencies
			// must remain nested when the Pi workspace needs a different version.
			if (nestedVersion && nestedVersion === rootVersion) {
				rmSync(nestedPackage, { recursive: true, force: true });
				removed.push(`packages/${entry.name}/${dependencyPath}@${nestedVersion}`);
			} else if (nestedVersion) {
				preserved.push(`packages/${entry.name}/${dependencyPath}@${nestedVersion}`);
			}
		}
	}

	for (const dependency of readdirSync(nested, { withFileTypes: true })) {
		if (dependency.isDirectory() && dependency.name.startsWith("@")) {
			const scope = join(nested, dependency.name);
			if (readdirSync(scope).length === 0) rmSync(scope, { recursive: true, force: true });
		}
	}
	if (readdirSync(nested).length === 0) rmSync(nested, { recursive: true, force: true });
}

if (removed.length > 0) {
	console.log(`Removed matching dependency copies from vendor/pi: ${removed.join(", ")}`);
}
if (preserved.length > 0) {
	console.log(`Kept package-specific Pi dependency versions: ${preserved.join(", ")}`);
}
