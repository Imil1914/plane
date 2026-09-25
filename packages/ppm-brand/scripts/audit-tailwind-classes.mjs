// UX0.2 B.2: fails when a class used in PPM-owned web sources does not produce CSS in the PPM Tailwind v4 theme.
// Resolution uses Tailwind's own design system (same entry as the build: apps/web/styles/globals.css),
// so no production build is needed. `--built <dir>` additionally cross-checks against built CSS.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const webRoot = path.join(repositoryRoot, "apps/web");
const argv = process.argv.slice(2);
const builtDir = argv.includes("--built") ? path.resolve(argv[argv.indexOf("--built") + 1]) : null;

// PPM-owned surfaces. ppm-* directories are discovered; files outside them are listed explicitly.
const scopeRoots = ["apps/web/core/components", "apps/web/app"];
const extraFiles = [
  "apps/web/app/(home)/about/brand-foundation/page.tsx",
  "apps/web/app/(home)/about/open-source/page.tsx",
  "apps/web/core/components/navigation/tab-navigation-overflow-menu.tsx",
  "apps/web/core/components/navigation/tab-navigation-visible-item.tsx",
  "apps/web/core/components/navigation/top-nav-power-k.tsx",
  "apps/web/core/components/workspace/sidebar/project-navigation.tsx",
  "apps/web/core/layouts/auth-layout/project-wrapper.tsx",
  // UX1.1 F4: profile preferences and the shared state dropdown (F).
  "apps/web/core/components/appearance/theme-switcher.tsx",
  "apps/web/core/components/dropdowns/state/base.tsx",
  "apps/web/core/components/profile/start-of-week-preference.tsx",
  "apps/web/core/components/settings/profile/content/pages/preferences/default-list.tsx",
  "apps/web/core/components/settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
  // UX1.1 lane T: Plane files the Tasks lane edits (plan-T-needs.md N3).
  "apps/web/app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/issues/(list)/layout.tsx",
  "apps/web/core/components/issues/header.tsx",
  "apps/web/core/components/issues/issue-layouts/filters/header/layout-selection.tsx",
  "apps/web/core/components/issues/issue-layouts/kanban/default.tsx",
  "apps/web/core/components/issues/issue-layouts/list/block-root.tsx",
  "apps/web/core/components/issues/issue-layouts/list/block.tsx",
  "apps/web/core/components/issues/issue-layouts/list/default.tsx",
  "apps/web/core/components/issues/issue-layouts/list/headers/group-by-card.tsx",
  "apps/web/core/components/issues/issue-layouts/list/list-group.tsx",
  "apps/web/core/components/issues/issue-layouts/quick-add/button/list.tsx",
  "apps/web/core/components/issues/issue-layouts/roots/project-layout-root.tsx",
  // UX1.1 F5: shell files with v2 branches or hooks.
  "apps/web/app/(all)/[workspaceSlug]/(projects)/layout.tsx",
  "apps/web/app/(all)/[workspaceSlug]/(settings)/layout.tsx",
  "apps/web/app/(all)/settings/profile/layout.tsx",
  "apps/web/core/components/navigation/top-navigation-root.tsx",
  "apps/web/core/components/sidebar/sidebar-navigation.tsx",
  "apps/web/core/components/sidebar/sidebar-wrapper.tsx",
  "apps/web/core/components/workspace/content-wrapper.tsx",
  "apps/web/core/components/workspace/sidebar/projects-list-item.tsx",
  "apps/web/core/components/workspace/sidebar/workspace-menu-root.tsx",
];
// Plain (non-Tailwind) CSS that defines PPM classes such as ppm-canvas-*.
const customCssFiles = [
  "apps/web/core/components/ppm-canvas/canvas.css",
  "apps/web/core/components/ppm-canvas/canvas-v2.css",
  "apps/web/styles/globals.css",
  "apps/web/styles/power-k.css",
  "apps/web/styles/emoji.css",
  "apps/web/styles/ppm-v2/system.css",
  "apps/web/styles/ppm-v2/shell.css",
  "apps/web/styles/ppm-v2/tasks.css",
  "packages/tailwind-config/index.css",
  "packages/ppm-brand/src/tokens.css",
  "packages/ppm-brand/src/tokens-v2.css",
];

const requireWeb = createRequire(path.join(webRoot, "package.json"));
const ts = requireWeb("typescript");
const requireTailwindPostcss = createRequire(requireWeb.resolve("@tailwindcss/postcss"));
const tailwindNode = await import(pathToFileURL(requireTailwindPostcss.resolve("@tailwindcss/node")).href);
if (typeof tailwindNode.__unstable__loadDesignSystem !== "function") {
  console.error(
    "Tailwind design-system API is unavailable: update audit-tailwind-classes.mjs for the new Tailwind version."
  );
  process.exit(1);
}

// Editor/Propel styles resolve into dist/ and contain no @theme/@utility; skip them so no package build is needed.
const entryPath = path.join(webRoot, "styles/globals.css");
const entryCss = readFileSync(entryPath, "utf8").replace(
  /^@import\s+"@plane\/(?:editor\/styles|propel\/styles\/[^"]+)";\s*$/gm,
  ""
);
const designSystem = await tailwindNode.__unstable__loadDesignSystem(entryCss, { base: path.dirname(entryPath) });
const producesCss = (candidate) => designSystem.candidatesToCss([candidate])[0] !== null;

// Canaries: a silently broken theme load must not pass the audit.
for (const [candidate, expected] of [
  ["bg-danger-subtle", true],
  ["text-success-primary", true],
  ["shadow-overlay-200", true],
  ["font-code", true],
  ["bg-red-500", false],
  ["shadow-2xl", false],
  ["font-mono", false],
  ["text-15", false],
]) {
  if (producesCss(candidate) !== expected) {
    console.error(`Tailwind class audit canary failed: ${candidate} expected ${expected ? "present" : "absent"}.`);
    process.exit(1);
  }
}

const customClasses = new Set();
for (const file of customCssFiles) {
  const absolute = path.join(repositoryRoot, file);
  if (existsSync(absolute)) collectClassSelectors(readFileSync(absolute, "utf8"), customClasses);
}
const builtClasses = new Set();
if (builtDir) {
  for (const file of readdirSync(builtDir).filter((name) => name.endsWith(".css")))
    collectClassSelectors(readFileSync(path.join(builtDir, file), "utf8"), builtClasses);
}

const files = [
  ...scopeRoots.flatMap((root) => walk(path.join(repositoryRoot, root)).filter((file) => /\/ppm-[^/]+\//.test(file))),
  ...extraFiles.map((file) => path.join(repositoryRoot, file)).filter(existsSync),
].filter((file) => /\.(?:ts|tsx)$/.test(file));

const CLASS_ATTRIBUTE = /^(?:class|className|[a-zA-Z]+ClassName)$/;
const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "twMerge", "twJoin", "classNames", "cva"]);
const CLASS_BINDING = /(?:[cC]lass(?:Name)?(?:es|s)?|CLASS(?:_?NAME)?S?|Tones?|TONES?)$/;
const violations = [];
const warnings = [];

for (const file of [...new Set(files)].sort()) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relativePath = path.relative(repositoryRoot, file);

  const visit = (node, inClassContext) => {
    if (ts.isTypeNode(node)) return;
    let context = inClassContext;
    if (ts.isJsxAttribute(node) && CLASS_ATTRIBUTE.test(node.name.getText(sourceFile))) context = true;
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPERS.has(node.expression.text))
      context = true;
    else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      CLASS_BINDING.test(node.name.getText(sourceFile))
    )
      context = true;

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkString(node, node.text, context, false, false);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      checkString(node.head, node.head.text, context, false, true);
      node.templateSpans.forEach((span, index) => {
        checkString(span.literal, span.literal.text, context, true, index < node.templateSpans.length - 1);
        visit(span.expression, context);
      });
      return;
    }
    if (context && ts.isConditionalExpression(node)) {
      visit(node.condition, false);
      visit(node.whenTrue, true);
      visit(node.whenFalse, true);
      return;
    }
    if (context && ts.isBinaryExpression(node) && /Equals/.test(ts.SyntaxKind[node.operatorToken.kind])) return;
    if (ts.isElementAccessExpression(node)) {
      visit(node.expression, context);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, context));
  };

  const checkString = (node, text, inClassContext, dynamicStart, dynamicEnd) => {
    const parent = node.parent;
    if (parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))) return;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    // Outside an obvious class context, only class-shaped strings (e.g. tone maps) are checked.
    if (!inClassContext) {
      if (tokens.length < 2 || !tokens.every((token) => /^[!-]?[a-z0-9@[][\w:\-[\]/.%#(),=&>*@'"!]*$/.test(token)))
        return;
      const tailwindLike = tokens.filter((token) => designSystem.parseCandidate(token).length > 0).length;
      if (tailwindLike / tokens.length < 0.6) return;
    }
    let offset = 0;
    tokens.forEach((token, index) => {
      const at = text.indexOf(token, offset);
      offset = at + token.length;
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile) + 1 + at);
      const location = `${relativePath}:${line + 1}`;
      const isFragment =
        (index === 0 && dynamicStart && !/^\s/.test(text)) ||
        (index === tokens.length - 1 && dynamicEnd && !/\s$/.test(text));
      if (isFragment) return warnings.push(`${location}: dynamic fragment "${token}"`);
      if (producesCss(token) || customClasses.has(token) || /^(?:group|peer)(?:\/[\w-]+)?$/.test(token)) {
        if (builtDir && producesCss(token) && !builtClasses.has(token))
          violations.push(`${location}: ${token} is valid but missing from built CSS (file not scanned?)`);
        return;
      }
      const variants = splitVariants(token);
      const utility = variants.at(-1);
      if (designSystem.parseCandidate(token).length > 0 || designSystem.parseCandidate(utility).length > 0)
        violations.push(`${location}: ${token}`);
      else if (variants.length > 1 && producesCss(utility)) violations.push(`${location}: ${token} (unknown variant)`);
      else warnings.push(`${location}: "${token}" is neither a Tailwind utility nor a class in scanned CSS`);
    });
  };

  visit(sourceFile, false);
}

if (warnings.length > 0)
  console.warn("Tailwind class audit notes:\n" + warnings.map((value) => `- ${value}`).join("\n"));
if (violations.length > 0) {
  console.error(
    "PPM Tailwind class audit failed. These classes produce no CSS with the PPM theme " +
      "(packages/tailwind-config/variables.css resets --color-*, --shadow-*, --font-*, --text-*, --tracking-*); " +
      "use semantic utilities such as bg-danger-subtle, text-success-primary, shadow-overlay-200, font-code:\n" +
      violations.map((value) => `- ${value}`).join("\n")
  );
  process.exitCode = 1;
} else {
  console.log(
    `PPM Tailwind class audit passed (${files.length} files${builtDir ? ", cross-checked with built CSS" : ""}).`
  );
}

function collectClassSelectors(css, target) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let prelude = "";
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (char === "\\") {
      prelude += char + (withoutComments[index + 1] ?? "");
      index += 1;
    } else if (char === "{") {
      if (!prelude.trim().startsWith("@"))
        for (const match of prelude.matchAll(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w\-\u00A0-\uFFFF])+)/g))
          target.add(
            match[1]
              .replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
              .replace(/\\(.)/g, "$1")
          );
      prelude = "";
    } else if (char === "}" || char === ";") prelude = "";
    else prelude += char;
  }
}

function splitVariants(candidate) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of candidate) {
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth -= 1;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function walk(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "build" || entry === ".react-router") continue;
    const filePath = path.join(root, entry);
    if (statSync(filePath).isDirectory()) files.push(...walk(filePath));
    else files.push(filePath);
  }
  return files;
}
