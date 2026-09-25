/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import DOMPurify, { type Config, type WindowLike } from "dompurify";
import { renderToString } from "katex";
import { Marked, type RendererObject, type TokenizerAndRendererExtension, type TokenizerObject } from "marked";
import { escapeHtml, highlightCodeHtml, normalizeCodeLanguage } from "./canvas-code";

// AF2.1 B1: Markdown заметки. Три слоя защиты: (1) сырой HTML экранируется в marked (tag/inlineText без «сырого»
// режима, renderer.html), картинки не рендерятся, опасные ссылки превращаются в текст; (2) KaTeX с trust:false;
// (3) отдельный экземпляр DOMPurify перед вставкой в DOM (SVG/MathML и style — только у вывода KaTeX).

/**
 * Больше — показываем текстом без разбора (решение контроллера, раунд 1): разбор не должен подвешивать вкладку.
 * Лимит длины — не только про размер: он же держит квадратичные пути marked, которые линейный оценщик ниже
 * (markdownScanCost) не моделирует, — внутрисловные «_» и код-спаны (серии обратных кавычек). Не поднимать лимит без
 * замеров на вредных вводах у новой границы (см. бюджет времени в note-markdown.test.ts).
 */
export const CANVAS_MARKDOWN_MAX_CHARS = 10_000;

// Ссылки: только http(s), mailto, путь от корня (но не «//хост» и не «/\хост» — браузер читает их как чужой хост)
// и якорь. Пробелы и управляющие символы не считаются: URL-парсер браузера их выбрасывает.
const SAFE_HREF = /^(?:https?:|mailto:|\/(?![\\/])|#)/i;
// oxlint-disable-next-line no-control-regex -- управляющие символы и пробелы: URL-парсер браузера их выбрасывает
const URL_IGNORED_CHARACTERS = /[\x00-\x20\s]/g;

export function isSafeCanvasHref(href: string): boolean {
  return SAFE_HREF.test(href.replace(URL_IGNORED_CHARACTERS, ""));
}

export function isCanvasMarkdownTooLong(source: string): boolean {
  return source.length > CANVAS_MARKDOWN_MAX_CHARS;
}

// ── Защита от долгого разбора (раунд 2) ──
// marked 16.4.2 и под лимитом длины разбирает вредный ввод секундами: незакрытые ссылки «[a](…» — кубически
// (2 400 × «[a](» ≈ 15 с: от каждой «](» регулярка ссылки откатывается по «слову» и от каждой его «(» ищет «)» до конца
// абзаца), незакрытые серии * и _ — квадратично (3 300 × «_a*» ≈ 0,7–1 с). Перед разбором — линейная оценка сверху
// по блокам: абзац до пустой строки или до строки, которая в marked его прерывает (пункт «- * +» или «1.», заголовок #).
// Ссылки: Σ по «словам» (до пробела, табуляции, перевода строки, управляющего — там marked обрывает адрес) «](» × «(»,
// умноженная на длину блока; выделение: открывающие серии * и _ (как emStrongLDelim в marked), умноженные на длину
// блока. Суммы по заметке сверяются с бюджетами: на худшем найденном вводе у границы разбор < 100 мс.
// Внутрисловные «_» и код-спаны оценщик не считает: их квадратичную цену ограничивает только CANVAS_MARKDOWN_MAX_CHARS.
const LINK_SCAN_BUDGET = 50_000_000;
const EMPHASIS_SCAN_BUDGET = 700_000;
const BLOCK_BREAK_LINE = /^ {0,3}(?:[*+-]|1[.)])[ \t]|^ {0,3}#{1,6}(?:[ \t]|$)/;
// oxlint-disable-next-line no-control-regex -- адрес ссылки в marked: [^ \t\n\x00-\x1f]* (NBSP «слово» не обрывает)
const LINK_WORD_BREAK = /[\x00-\x20]+/;
const EMPHASIS_OPENER = /\*+(?=\S)|(?<![\p{L}\p{N}])_+(?=\S)/gu;

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

function scanBlocks(source: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const blank = !line.trim();
    if ((blank || BLOCK_BREAK_LINE.test(line)) && lines.length > 0) {
      blocks.push(lines.join("\n"));
      lines = [];
    }
    if (!blank) lines.push(line);
  }
  if (lines.length > 0) blocks.push(lines.join("\n"));
  return blocks;
}

/** Оценка сверху работы marked на вредных конструкциях (см. выше); линейна по длине текста. */
export function markdownScanCost(source: string): { emphasis: number; links: number } {
  let emphasis = 0;
  let links = 0;
  for (const block of scanBlocks(source)) {
    let linkWork = 0;
    if (block.includes("](")) {
      for (const word of block.split(LINK_WORD_BREAK)) {
        if (word.includes("](")) linkWork += countOccurrences(word, "](") * countOccurrences(word, "(");
      }
    }
    links += linkWork * block.length;
    emphasis += (block.match(EMPHASIS_OPENER)?.length ?? 0) * block.length;
  }
  return { emphasis, links };
}

export function isCanvasMarkdownTooComplex(source: string): boolean {
  const cost = markdownScanCost(source);
  // Общий бюджет: ссылки и выделение у границы одновременно не складываются в двойное время.
  return cost.links / LINK_SCAN_BUDGET + cost.emphasis / EMPHASIS_SCAN_BUDGET > 1;
}

/** Почему заметку показываем текстом без разбора: длина, сложность разметки — или разбираем. */
export function canvasMarkdownPlainReason(source: string): "complexity" | "length" | undefined {
  if (isCanvasMarkdownTooLong(source)) return "length";
  if (isCanvasMarkdownTooComplex(source)) return "complexity";
  return undefined;
}

function renderMath(tex: string, displayMode: boolean): string {
  return renderToString(tex, {
    displayMode,
    maxExpand: 200,
    maxSize: 20,
    output: "htmlAndMathml",
    strict: "ignore",
    throwOnError: false,
    trust: false,
  });
}

type TMathRender = (tex: string, displayMode: boolean) => string;

function mathExtensions(render: TMathRender): TokenizerAndRendererExtension[] {
  return [
    {
      name: "ppmMathBlock",
      level: "block",
      start(src) {
        return /^\$\$/m.exec(src)?.index;
      },
      tokenizer(src) {
        const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/.exec(src);
        return match ? { type: "ppmMathBlock", raw: match[0], text: match[1].trim() } : undefined;
      },
      renderer(token) {
        return render(String(token.text), true);
      },
    },
    {
      name: "ppmMathInline",
      level: "inline",
      start(src) {
        const index = src.indexOf("$");
        return index < 0 ? undefined : index;
      },
      tokenizer(src) {
        // «$…$»: без пробела у границ и без цифры сразу после закрывающего — «$5 и $6» остаётся текстом.
        const match = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
        return match ? { type: "ppmMathInline", raw: match[0], text: match[1] } : undefined;
      },
      renderer(token) {
        return render(String(token.text), false);
      },
    },
  ];
}

// marked 16: встроенный тег <pre|code|kbd|script> включает «сырой» режим лексера (state.inRawBlock), и дальше текст
// уходит в HTML без экранирования — даже в следующих абзацах. Здесь тег — обычный html-токен без смены состояния
// (renderer.html его экранирует), а текст никогда не помечается как «уже экранированный».
const noRawHtmlTokenizer: TokenizerObject = {
  tag(src) {
    const match = this.rules.inline.tag.exec(src);
    return match
      ? { type: "html", raw: match[0], text: match[0], inLink: false, inRawBlock: false, block: false }
      : undefined;
  },
  inlineText(src) {
    const match = this.rules.inline.text.exec(src);
    return match ? { type: "text", raw: match[0], text: match[0], escaped: false } : undefined;
  },
};

function safeRenderer(code: RendererObject["code"]): RendererObject {
  return {
    html({ text }) {
      return escapeHtml(text);
    },
    checkbox({ checked }) {
      // GFM «- [x]»: отметка — символом, не <input> (DOMPurify убирает поля форм, и состояние пропало бы).
      return checked ? "☑" : "☐";
    },
    image({ text }) {
      // RB3: без внешних запросов — картинки из Markdown не загружаются, остаётся подпись.
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!isSafeCanvasHref(href)) return label;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href.trim())}"${titleAttribute} rel="noopener noreferrer nofollow" target="_blank">${label}</a>`;
    },
    code,
  };
}

const noteMarkdown = new Marked({ async: false, breaks: true, gfm: true });
noteMarkdown.use({
  extensions: mathExtensions((tex, displayMode) =>
    displayMode ? `<div class="ppm-note-math">${renderMath(tex, true)}</div>\n` : renderMath(tex, false)
  ),
  renderer: safeRenderer(({ text, lang }) => {
    const language = normalizeCodeLanguage(lang);
    return `<pre class="ppm-note-code"><code class="hljs language-${language}">${highlightCodeHtml(text, language)}</code></pre>\n`;
  }),
  tokenizer: noRawHtmlTokenizer,
});

// «Сделать документом»: HTML для редактора «Документов» — без разметки KaTeX (её схема редактора не знает),
// формулы остаются исходником в <code>, код — обычным <pre><code>.
const pageMarkdown = new Marked({ async: false, breaks: true, gfm: true });
pageMarkdown.use({
  extensions: mathExtensions((tex, displayMode) =>
    displayMode ? `<pre><code>${escapeHtml(`$$${tex}$$`)}</code></pre>\n` : `<code>${escapeHtml(`$${tex}$`)}</code>`
  ),
  renderer: safeRenderer(({ text, lang }) => {
    const language = normalizeCodeLanguage(lang);
    const languageClass = language === "plaintext" ? "" : ` class="language-${language}"`;
    return `<pre><code${languageClass}>${escapeHtml(text)}</code></pre>\n`;
  }),
  tokenizer: noRawHtmlTokenizer,
});

/** Текст без разметки как HTML: абзацы по пустым строкам, переводы строк — <br>, всё экранировано. */
export function plainTextToHtml(text: string): string {
  return text
    .split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Длиннее лимита или слишком сложно — без разбора; ошибка разбора (язык кода, формула…) — тоже текст. */
export function renderMarkdownOrPlainText(source: string, render: (markdown: string) => string): string {
  if (canvasMarkdownPlainReason(source)) return plainTextToHtml(source);
  try {
    return render(source);
  } catch {
    return plainTextToHtml(source);
  }
}

/** HTML заметки до санитизации (в DOM — только через sanitizeCanvasHtml). Не бросает исключений. */
export function renderCanvasMarkdown(source: string): string {
  return renderMarkdownOrPlainText(source, (markdown) => noteMarkdown.parse(markdown) as string);
}

export function markdownToPageHtml(source: string): string {
  return renderMarkdownOrPlainText(source, (markdown) => pageMarkdown.parse(markdown) as string);
}

// ── Санитизация ──

/** Свойства, которые KaTeX пишет во встроенный style (katex.mjs: style.* и markup рамок); position — только relative. */
const KATEX_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  "background-color",
  "border",
  "border-bottom-width",
  "border-color",
  "border-right-style",
  "border-right-width",
  "border-style",
  "border-top-width",
  "border-width",
  "bottom",
  "color",
  "height",
  "left",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "min-width",
  "padding-left",
  "position",
  "text-shadow",
  "top",
  "vertical-align",
  "width",
]);
// Значение — только числа с единицами, #цвет и слова через пробел: без скобок (url(), var(), expression()), «@»,
// «\» (CSS-экранирование обходит поиск подстрок), кавычек, «/» и «!important».
const STYLE_TOKEN = String.raw`(?:-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|pt|%)?|#[\da-f]{3,8}|[a-z]+(?:-[a-z]+)*)`;
const STYLE_VALUE = new RegExp(String.raw`^${STYLE_TOKEN}(?:\s+${STYLE_TOKEN})*$`, "i");

/** Встроенный стиль разметки KaTeX: остаются только его декларации раскладки и цвета; пустая строка — убрать. */
export function sanitizeKatexStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!KATEX_STYLE_PROPERTIES.has(property) || !STYLE_VALUE.test(value)) continue;
    if (property === "position" && value.toLowerCase() !== "relative") continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(";");
}

/**
 * ALLOWED_URI_REGEXP для DOMPurify. Он проверяет им ВСЕ атрибуты, кроме «безопасных» (class, style, title…) — в том
 * числе d, viewBox, target, rel, — поэтому строение как у регулярки DOMPurify по умолчанию (значения-не-адреса
 * проходят), но из схем — только http(s) и mailto, и никаких «//хост», «\\хост», «/\хост». Цифры — в классах схемы
 * (раунд 2): «h323:x», «x1:y» — тоже схемы.
 */
export const CANVAS_ALLOWED_URI = /^(?:(?:https?|mailto):|(?![\\/]{2})[^a-z]|[a-z0-9+.-]+(?:[^a-z0-9+.\-:]|$))/i;

const FORBIDDEN_ATTRIBUTES = ["formaction", "id", "name", "srcset", "xlink:href"];
const FORBIDDEN_TAGS = [
  "audio",
  "base",
  "button",
  "embed",
  "form",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "select",
  "source",
  "style",
  "textarea",
  "use",
  "video",
];

const CANVAS_PURIFY_CONFIG: Config = {
  ADD_ATTR: ["target"],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: CANVAS_ALLOWED_URI,
  FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  FORBID_TAGS: FORBIDDEN_TAGS,
  USE_PROFILES: { html: true, mathMl: true, svg: true },
};

// Чужой HTML (например, description_html документа с сервера): class="katex" там можно подделать, поэтому никаких
// style, SVG и MathML — независимо от классов. KaTeX бывает только в заметке, которую мы разобрали сами.
const CANVAS_PURIFY_STRICT_CONFIG: Config = {
  ...CANVAS_PURIFY_CONFIG,
  FORBID_ATTR: [...FORBIDDEN_ATTRIBUTES, "style"],
  FORBID_TAGS: [...FORBIDDEN_TAGS, "math", "svg"],
  USE_PROFILES: { html: true },
};

export function canvasPurifyConfig(allowKatex: boolean): Config {
  return allowKatex ? CANVAS_PURIFY_CONFIG : CANVAS_PURIFY_STRICT_CONFIG;
}

function isInside(node: Node | null, selector: string): boolean {
  return Boolean(node && "closest" in node && (node as Element).closest(selector));
}

// Отдельный экземпляр: хуки ниже не действуют на других пользователей DOMPurify в приложении (хуки глобальны
// для экземпляра). Без DOM (node, SSR) экземпляра нет — sanitizeCanvasHtml экранирует всё.
function createCanvasPurifier(root: WindowLike) {
  const purifier = DOMPurify(root);
  if (!purifier.isSupported) return undefined;
  purifier.addHook("uponSanitizeElement", (node, event) => {
    // SVG и MathML — только внутри вывода KaTeX; вне его удаляются вместе с содержимым.
    if ((event.tagName === "svg" || event.tagName === "math") && !isInside(node.parentNode, ".katex")) {
      node.parentNode?.removeChild(node);
    }
  });
  purifier.addHook("uponSanitizeAttribute", (node, event) => {
    if (event.attrName !== "style") return;
    // Встроенный стиль — только у разметки KaTeX (и её красной ошибки) и только её декларации.
    const style = isInside(node, ".katex, .katex-error") ? sanitizeKatexStyle(event.attrValue) : "";
    if (style) event.attrValue = style;
    else event.keepAttr = false;
  });
  return purifier;
}

const canvasPurifier = typeof window === "undefined" ? undefined : createCanvasPurifier(window);

/**
 * allowKatex: true — наш HTML заметки (KaTeX: style по белому списку, SVG/MathML внутри .katex); false — строгий режим
 * для чужого HTML (превью документа и т. п.): все style, SVG и MathML удаляются.
 */
export function sanitizeCanvasHtml(html: string, { allowKatex = true }: { allowKatex?: boolean } = {}): string {
  // Без DOM (node, SSR) DOMPurify не работает: не пропускаем разметку вовсе.
  if (!canvasPurifier) return escapeHtml(html);
  return canvasPurifier.sanitize(html, canvasPurifyConfig(allowKatex));
}

// ── Имя задачи/документа ──

// Строки-ограждения блоков кода и формул («```py», «~~~», «$$») именем не бывают.
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,}|\$\$)/;
// Префикс строки: заголовок, цитата, пункт списка (в том числе «- [x]»).
const LINE_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\$\$/g, "")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}_*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])/gu, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

/** Имя задачи/документа: заголовок заметки или первая строка с текстом, без разметки Markdown, ≤ 255. */
export function noteTaskName(title: string, body: string): string {
  const fromTitle = title.trim();
  if (fromTitle) return fromTitle.slice(0, 255);
  for (const raw of body.split("\n")) {
    if (FENCE_LINE.test(raw)) continue;
    // Раунд 2: очистка квадратична на длинной строке — хватит её начала (имя всё равно ≤ 255).
    const line = stripInlineMarkdown(raw.slice(0, 2_000).replace(LINE_PREFIX, ""));
    if (line) return line.slice(0, 255);
  }
  return "";
}
