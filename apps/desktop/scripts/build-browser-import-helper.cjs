// The Windows helper runs on the .NET Framework already included with Windows.
// Compile it for AnyCPU on the Windows build runner; do not commit an executable.
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

if (process.platform === "win32") {
  const desktop = join(__dirname, "..");
  const framework = process.arch === "arm64" ? "FrameworkArm64" : "Framework64";
  const compiler = join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
  const source = join(desktop, "native", "browser-import", "BrowserImportKeyHelper.cs");
  const outputDir = join(desktop, "build", "browser-import-helper");
  if (!existsSync(compiler)) throw new Error("Windows .NET Framework compiler is unavailable: " + compiler);
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, "BrowserImportKeyHelper.exe");
  const result = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:anycpu", `/out:${output}`, source], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log("Built Windows browser import helper.");
}
