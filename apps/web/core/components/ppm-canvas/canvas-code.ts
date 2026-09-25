/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import HighlightJs from "highlight.js/lib/core";
import { common, createLowlight } from "lowlight";

// AF2.1 B1/B2: локальная подсветка (lowlight = highlight.js, набор common). Без сети и без innerHTML в блоке кода:
// дерево hast превращается в плоские сегменты; HTML-строка для заметок собирается с экранированием.
const lowlight = createLowlight(common);

/** Выше этого размера подсветка выключается: 300 фигур без просадки (инвариант спецификации). */
export const CODE_HIGHLIGHT_MAX_CHARS = 20_000;

export const CODE_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  plaintext: "Plain Text",
  arduino: "Arduino",
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  markdown: "Markdown",
  objectivec: "Objective-C",
  perl: "Perl",
  php: "PHP",
  "php-template": "PHP Template",
  python: "Python",
  "python-repl": "Python REPL",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  vbnet: "VB.NET",
  wasm: "WebAssembly",
  xml: "XML / HTML",
  yaml: "YAML",
};

/** «Plain Text» первым, затем языки lowlight common по подписи. */
export const CANVAS_CODE_LANGUAGES: readonly string[] = [
  "plaintext",
  ...lowlight
    .listLanguages()
    .filter((language) => language !== "plaintext")
    // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array (lib ES2022: no toSorted).
    .sort((left, right) =>
      (CODE_LANGUAGE_LABELS[left] ?? left).localeCompare(CODE_LANGUAGE_LABELS[right] ?? right, "en")
    ),
];

// Псевдонимы PPM поверх псевдонимов highlight.js. Map, а не объект: «constructor» или «__proto__» не должны находить
// члены Object.prototype (B1, раунд 1: такое ограждение кода роняло карточку у всех зрителей).
const PPM_LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["", "plaintext"],
  ["text", "plaintext"],
  ["txt", "plaintext"],
  ["plain", "plaintext"],
  ["tex", "plaintext"],
  ["latex", "plaintext"],
  ["py", "python"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["sh", "bash"],
  ["zsh", "bash"],
  ["yml", "yaml"],
  ["html", "xml"],
  ["htm", "xml"],
  ["svg", "xml"],
  ["md", "markdown"],
  ["c++", "cpp"],
  ["c#", "csharp"],
  ["cs", "csharp"],
  ["rs", "rust"],
  ["rb", "ruby"],
  ["kt", "kotlin"],
  ["golang", "go"],
  ["h", "c"],
  ["hpp", "cpp"],
  ["m", "objectivec"],
  ["pl", "perl"],
  ["vb", "vbnet"],
  ["mk", "makefile"],
]);

// Имя реестра lowlight для имени или псевдонима highlight.js (cc → cpp, console → shell). Наружу lowlight псевдонимы
// не разрешает, поэтому таблица строится по определениям тех же языков common на отдельном экземпляре highlight.js
// (глобально ничего не регистрируется).
const CANONICAL_LANGUAGES: ReadonlyMap<string, string> = (() => {
  const grammarApi = HighlightJs.newInstance();
  const names = new Map<string, string>();
  for (const [name, grammar] of Object.entries(common)) {
    names.set(name, name);
    for (const alias of grammar(grammarApi).aliases ?? []) {
      if (!names.has(alias.toLowerCase())) names.set(alias.toLowerCase(), name);
    }
  }
  for (const [alias, name] of PPM_LANGUAGE_ALIASES) names.set(alias, name);
  return names;
})();

export function normalizeCodeLanguage(value: string | null | undefined): string {
  // Строка info у ограждения кода: язык — первое слово («py title=x» → python); результат — имя реестра.
  const word = (value ?? "").trim().split(/\s+/, 1)[0].toLowerCase();
  const name = CANONICAL_LANGUAGES.get(word);
  return name && lowlight.registered(name) ? name : "plaintext";
}

export function codeLanguageLabel(language: string): string {
  const normalized = normalizeCodeLanguage(language);
  return CODE_LANGUAGE_LABELS[normalized] ?? normalized;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type TCodeSegment = { className: string; text: string };

// Минимальная форма узла hast (lowlight отдаёт Root); тип «hast» напрямую apps/web недоступен (isolated linker).
type THastNode = {
  children?: THastNode[];
  properties?: { className?: unknown };
  type: string;
  value?: string;
};

function collectSegments(node: THastNode, classes: readonly string[], out: TCodeSegment[]) {
  if (node.type === "text") {
    out.push({ className: classes.join(" "), text: node.value ?? "" });
    return;
  }
  const own = Array.isArray(node.properties?.className) ? (node.properties.className as string[]) : [];
  const next = own.length > 0 ? [...classes, ...own] : classes;
  for (const child of node.children ?? []) collectSegments(child, next, out);
}

/** Строки кода с сегментами подсветки; токен, занимающий несколько строк, режется по `\n`. */
export function highlightCodeLines(code: string, language: string): TCodeSegment[][] {
  const normalized = normalizeCodeLanguage(language);
  const segments: TCodeSegment[] = [];
  if (normalized === "plaintext" || code.length > CODE_HIGHLIGHT_MAX_CHARS) {
    segments.push({ className: "", text: code });
  } else {
    collectSegments(lowlight.highlight(normalized, code) as unknown as THastNode, [], segments);
  }
  const lines: TCodeSegment[][] = [[]];
  for (const segment of segments) {
    segment.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ className: segment.className, text: part });
    });
  }
  return lines;
}

/** Экранированный HTML подсветки (для заметок; перед вставкой всё равно проходит sanitizeCanvasHtml). */
export function highlightCodeHtml(code: string, language: string): string {
  return highlightCodeLines(code, language)
    .map((line) =>
      line
        .map((segment) =>
          segment.className
            ? `<span class="${escapeHtml(segment.className)}">${escapeHtml(segment.text)}</span>`
            : escapeHtml(segment.text)
        )
        .join("")
    )
    .join("\n");
}

// ── B2: блок кода ──
export type TCodeTheme = "auto" | "dark" | "light";

const CODE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  plaintext: "txt",
  arduino: "ino",
  bash: "sh",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  diff: "diff",
  go: "go",
  graphql: "graphql",
  ini: "ini",
  java: "java",
  javascript: "js",
  json: "json",
  kotlin: "kt",
  less: "less",
  lua: "lua",
  makefile: "mk",
  markdown: "md",
  objectivec: "m",
  perl: "pl",
  php: "php",
  "php-template": "php",
  python: "py",
  "python-repl": "py",
  r: "r",
  ruby: "rb",
  rust: "rs",
  scss: "scss",
  shell: "sh",
  sql: "sql",
  swift: "swift",
  typescript: "ts",
  vbnet: "vb",
  wasm: "wat",
  xml: "xml",
  yaml: "yaml",
};

export function codeFileExtension(language: string): string {
  return CODE_FILE_EXTENSIONS[normalizeCodeLanguage(language)] ?? "txt";
}

export function codeDownloadName(title: string, language: string): string {
  const base =
    title
      // oxlint-disable-next-line no-control-regex -- intentional: strips control chars alongside Windows-invalid filename chars
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "code";
  return `${base}.${codeFileExtension(language)}`;
}

/** Язык подсветки по имени файла («calibrate.py» → python); неизвестное — Plain Text. */
export function languageForFileName(name: string): string {
  const extension = /\.([a-z0-9+#-]+)$/i.exec(name)?.[1] ?? "";
  return normalizeCodeLanguage(extension);
}

/** Tab — два пробела у курсора или у каждой строки выделения; Shift+Tab — снять до двух пробелов. */
export function insertSoftTab(
  value: string,
  start: number,
  end: number,
  outdent: boolean
): { end: number; start: number; value: string } {
  const indent = "  ";
  if (!outdent && start === end) {
    return {
      end: start + indent.length,
      start: start + indent.length,
      value: value.slice(0, start) + indent + value.slice(end),
    };
  }
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  const changed = lines.map((line) => (outdent ? line.replace(/^ {1,2}/, "") : indent + line));
  const nextBlock = changed.join("\n");
  const firstDelta = changed[0].length - lines[0].length;
  return {
    end: end + (nextBlock.length - block.length),
    start: Math.max(lineStart, start + firstDelta),
    value: value.slice(0, lineStart) + nextBlock + value.slice(end),
  };
}

export function nextCodeTheme(theme: TCodeTheme): TCodeTheme {
  return theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
}

export function resolveCodeTheme(theme: TCodeTheme, appDark: boolean): "dark" | "light" {
  if (theme === "auto") return appDark ? "dark" : "light";
  return theme;
}
