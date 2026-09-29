import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(repoRoot, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const sourceData = path.join(repoRoot, "vendor/pi/packages/ai/dist/providers/data");
const sourceAnthropic = path.join(sourceData, "anthropic.json");

if (!existsSync(sourceAnthropic)) {
  throw new Error(`Generated Pi model data is missing: ${sourceAnthropic}`);
}

const anthropicModels = Object.values(JSON.parse(readFileSync(sourceAnthropic, "utf8")))
  .flatMap((providerModels) => Object.values(providerModels));
if (!anthropicModels.some((model) => model.id === "claude-sonnet-5-5")) {
  throw new Error("Generated Pi model data does not include claude-sonnet-5-5");
}

const physicalCopies = Object.entries(lock.packages ?? {})
  .filter(([packagePath, metadata]) =>
    packagePath.endsWith("node_modules/@earendil-works/pi-ai") && !metadata.link,
  )
  .map(([packagePath]) => path.join(repoRoot, packagePath));

for (const packagePath of physicalCopies) {
  const destinationData = path.join(packagePath, "dist/providers/data");
  if (!existsSync(path.dirname(destinationData))) {
    throw new Error(`Pi dependency has no generated dist directory: ${packagePath}`);
  }
  cpSync(sourceData, destinationData, { recursive: true, force: true });
  console.log(`Synchronized generated Pi model data into ${path.relative(repoRoot, packagePath)}`);
}

if (physicalCopies.length === 0) {
  console.log("No physical registry copy of @earendil-works/pi-ai found in package-lock.json");
}
