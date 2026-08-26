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
 * own tree, so the nested copies are never needed - drop them before building.
 */
import { readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(repoRoot, "vendor", "pi", "packages");

if (!existsSync(join(repoRoot, "vendor", "pi", "node_modules"))) {
	// Pi has not been installed yet; its packages carry no nested copies to remove.
	process.exit(0);
}

const removed = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const nested = join(packagesDir, entry.name, "node_modules");
	if (!existsSync(nested)) continue;
	rmSync(nested, { recursive: true, force: true });
	removed.push(`packages/${entry.name}`);
}

if (removed.length > 0) {
	console.log(`Removed root-install leftovers from vendor/pi: ${removed.join(", ")}`);
}
