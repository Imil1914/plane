import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  CANVAS_CODE_LANGUAGES,
  codeDownloadName,
  codeFileExtension,
  codeLanguageLabel,
  highlightCodeLines,
  insertSoftTab,
  languageForFileName,
  nextCodeTheme,
  resolveCodeTheme,
} from "@/components/ppm-canvas/canvas-code";
import { codeControlState } from "@/components/ppm-canvas/code-block";

const read = (name: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8");
const shapeSource = read("shape.tsx");
const codeSource = read("code-block.tsx");
const css = read("canvas-content.css")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ");
const plainFallbackLines = (code: string) =>
  code.split("\n").map((line) => (line ? [{ className: "", text: line }] : []));

describe("code block card (AF2.1 B2, K3)", () => {
  it("offers Plain Text first and the lowlight common set", () => {
    expect(CANVAS_CODE_LANGUAGES[0]).toBe("plaintext");
    expect(CANVAS_CODE_LANGUAGES).toHaveLength(37);
    expect(CANVAS_CODE_LANGUAGES).toEqual(expect.arrayContaining(["python", "typescript", "json", "sql", "bash"]));
    expect(codeLanguageLabel("plaintext")).toBe("Plain Text");
    expect(codeLanguageLabel("text")).toBe("Plain Text");
    expect(codeLanguageLabel("cpp")).toBe("C++");
  });

  it("splits highlighted code into numbered lines, multi-line tokens included", () => {
    const lines = highlightCodeLines('x = 1\n"""doc\nstring"""\nreturn x', "python");
    expect(lines).toHaveLength(4);
    expect(lines[1].map((segment) => segment.className)).toContain("hljs-string");
    expect(lines[2][0]).toEqual({ className: "hljs-string", text: 'string"""' });
    expect(lines[3][0]).toEqual({ className: "hljs-keyword", text: "return" });
    expect(highlightCodeLines("a\n", "plaintext")).toEqual([[{ className: "", text: "a" }], []]);
  });

  it("downloads with the right extension and a safe name", () => {
    expect(codeFileExtension("python")).toBe("py");
    expect(codeFileExtension("typescript")).toBe("ts");
    expect(codeFileExtension("text")).toBe("txt");
    expect(codeDownloadName("Классификатор цвета", "python")).toBe("Классификатор цвета.py");
    expect(codeDownloadName('a/b:c*?"<>|', "json")).toBe("a b c.json");
    expect(codeDownloadName("  ", "sql")).toBe("code.sql");
    expect(languageForFileName("calibrate.PY")).toBe("python");
    expect(languageForFileName("data.csv")).toBe("plaintext");
  });

  it("inserts and removes two-space indents with Tab / Shift+Tab", () => {
    expect(insertSoftTab("ab", 1, 1, false)).toEqual({ value: "a  b", start: 3, end: 3 });
    expect(insertSoftTab("a\nb", 0, 3, false)).toEqual({ value: "  a\n  b", start: 2, end: 7 });
    expect(insertSoftTab("  a\n  b", 0, 7, true)).toEqual({ value: "a\nb", start: 0, end: 3 });
    expect(insertSoftTab("  ab", 2, 2, true)).toEqual({ value: "ab", start: 0, end: 0 });
  });

  it("cycles the block theme auto → light → dark and resolves auto by the app theme", () => {
    expect(nextCodeTheme("auto")).toBe("light");
    expect(nextCodeTheme("light")).toBe("dark");
    expect(nextCodeTheme("dark")).toBe("auto");
    expect(resolveCodeTheme("auto", true)).toBe("dark");
    expect(resolveCodeTheme("auto", false)).toBe("light");
    expect(resolveCodeTheme("light", true)).toBe("light");
  });

  it("mounts the K3 block only under grammar v2 and never executes or injects code", () => {
    expect(shapeSource).toMatch(/grammarV2 && node\.kind === "code"/);
    expect(codeSource).not.toMatch(/dangerouslySetInnerHTML|new Function|eval\(/);
    expect(codeSource).toContain('event.code === "Tab"');
    expect(codeSource).not.toMatch(/event\.key ===/);
    expect(css).toContain(
      ':where(html[data-ppm-design="v2"]) [data-ppm-canvas-grammar="v2"] .ppm-code-block[data-theme="dark"]'
    );
  });

  it("never lets a bad language break the card: highlighting is wrapped, plain fallback matches the plaintext shape", () => {
    expect(codeSource).toMatch(/try\s*{\s*return highlightCodeLines\(node\.code, language\)/);
    expect(codeSource).toContain("} catch {");
    expect(plainFallbackLines("a\n")).toEqual(highlightCodeLines("a\n", "plaintext"));
    expect(plainFallbackLines('x = 1\n"""doc\nstring"""\nreturn x')).toEqual([
      [{ className: "", text: "x = 1" }],
      [{ className: "", text: '"""doc' }],
      [{ className: "", text: 'string"""' }],
      [{ className: "", text: "return x" }],
    ]);
  });

  it("locks controls but keeps the lock toggle itself workable for editors; copy/download are never gated by it", () => {
    expect(codeControlState(false, false)).toEqual({ controlsDisabled: false, lockDisabled: false });
    expect(codeControlState(false, true)).toEqual({ controlsDisabled: true, lockDisabled: false });
    expect(codeControlState(true, false)).toEqual({ controlsDisabled: true, lockDisabled: true });
    expect(codeControlState(true, true)).toEqual({ controlsDisabled: true, lockDisabled: true });
    expect(codeSource).toContain("codeControlState(readonly, node.locked)");
    const disabledControlsCount = (codeSource.match(/disabled=\{controlState\.controlsDisabled\}/g) ?? []).length;
    expect(disabledControlsCount).toBe(3); // theme button, language select, wrap menu item
    expect(codeSource).toContain("disabled={controlState.lockDisabled}");
    // Copy and Download stay available to everyone — no `disabled` on either button.
    expect(codeSource).toContain(
      '<button type="button" role="menuitem" onClick={() => void copy()} onPointerDown={stopEventPropagation}>'
    );
    expect(codeSource).toContain(
      '<button type="button" role="menuitem" onClick={download} onPointerDown={stopEventPropagation}>'
    );
    // The lock aria-label/aria-pressed pairing is state-consistent (a property name, not a flipped action verb).
    expect(codeSource).toContain('aria-label={ppmT("canvas.code_lock")}');
    expect(codeSource).toContain("aria-pressed={node.locked}");
  });

  it("closes the «…» menu on outside pointerdown and Escape, returns focus to the trigger, keeps Escape from tldraw", () => {
    expect(codeSource).toContain('document.addEventListener("pointerdown", onPointerDownOutside, true)');
    expect(codeSource).toMatch(/menuAnchorRef\.current\?\.contains\(event\.target as Node\)/);
    expect(codeSource).toContain('document.addEventListener("keydown", onKeyDownCapture, true)');
    expect(codeSource).toContain("const onKeyDownCapture = (event: globalThis.KeyboardEvent) => {");
    expect(codeSource).toMatch(
      /if \(event\.code !== "Escape"\) return;\s*event\.stopPropagation\(\);\s*event\.preventDefault\(\);/
    );
    // Every close path (Escape, outside click, and each menu item) returns focus to the trigger.
    expect(codeSource.match(/menuTriggerRef\.current\?\.focus\(\)/g) ?? []).toHaveLength(2); // effect + closeMenu
    expect(codeSource).toMatch(
      /const closeMenu = \(\) => \{\s*setMenuOpen\(false\);\s*menuTriggerRef\.current\?\.focus\(\);/
    );
    expect(codeSource.match(/closeMenu\(\);/g) ?? []).toHaveLength(3); // copy, download, wrap
    expect(codeSource).toContain("ref={menuAnchorRef}");
    expect(codeSource).toContain("ref={menuTriggerRef}");
  });

  it("names the toolbar in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.code_lock")).toBe("Только чтение");
    expect(getPpmTranslation("ru", "canvas.code_download")).toBe("Скачать файлом");
    expect(getPpmTranslation("ru", "canvas.code_wrap")).toBe("Перенос строк");
    expect(getPpmTranslation("en", "canvas.code_copy")).toBe("Copy");
  });
});

// Финальная волна (отложенное B2): осиротевший ключ «Разрешить правку» удалён — замок переключает одна кнопка
// с подписью «Только чтение» (aria-pressed), второй подписи нет ни в коде, ни в переводах.
describe("code block strings (final wave)", () => {
  it("drops the orphan canvas.code_unlock key in both languages and uses no such key", () => {
    const translations = readFileSync(
      new URL("../../../../packages/ppm-brand/src/translations/af21-canvas.ts", import.meta.url),
      "utf8"
    );
    expect(translations).not.toContain("canvas.code_unlock");
    for (const source of [codeSource, shapeSource, read("editor.tsx")]) expect(source).not.toContain("code_unlock");
  });
});
