import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRoots = [
  "packages/ppm-canvas/src",
  "apps/web/core/components/ppm-canvas",
  "apps/web/app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/brain",
];

const bannedImports = [
  "electron",
  "fs",
  "node:fs",
  "path",
  "node:path",
  "better-sqlite3",
  "child_process",
  "node:child_process",
  "@tldraw/sync",
  "@xterm/xterm",
];
const bannedRuntimeMarkers = ["ipcRenderer", "window.flow", "<webview", "BrowserWindow", "Jupyter", "kernel.start"];
const violations = [];

for (const sourceRoot of sourceRoots) {
  const absoluteRoot = path.join(repositoryRoot, sourceRoot);
  for (const filePath of walk(absoluteRoot)) {
    if (!/\.(?:ts|tsx)$/.test(filePath)) continue;
    const source = readFileSync(filePath, "utf8");
    const relativePath = path.relative(repositoryRoot, filePath);

    for (const match of source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (bannedImports.some((banned) => specifier === banned || specifier.startsWith(`${banned}/`)))
        violations.push(`${relativePath}: banned import ${specifier}`);
    }

    for (const marker of bannedRuntimeMarkers) {
      if (source.includes(marker)) violations.push(`${relativePath}: banned runtime marker ${marker}`);
    }
  }
}

if (violations.length > 0) {
  console.error("PPM Canvas browser boundary audit failed:\n" + violations.map((value) => `- ${value}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PPM Canvas browser boundary audit passed (${sourceRoots.length} isolated roots).`);
}

function walk(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const filePath = path.join(root, entry);
    if (statSync(filePath).isDirectory()) files.push(...walk(filePath));
    else files.push(filePath);
  }
  return files;
}
