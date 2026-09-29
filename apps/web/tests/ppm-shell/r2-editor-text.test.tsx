/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R2-4: the editor package (@plane/editor) has no i18n; its own texts (menu «/», formatting toolbar, colors,
// link/table/image menus, placeholders, upload errors) go through `editorText(key, <upstream>)`. The web registers the
// Russian PPM dictionary only in the Russian PPM interface; everywhere else — space, admin, the English interface,
// PPM_SHELL_ENABLED=0 — the editor keeps its upstream English byte for byte.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PPM_TRANSLATIONS } from "@ppm/brand";

const editorResolver = vi.hoisted(() => ({ current: null as ((key: string) => string | undefined) | null }));
vi.mock("@plane/editor", () => ({
  setEditorTextResolver: (resolver: ((key: string) => string | undefined) | null) => {
    editorResolver.current = resolver;
  },
}));
const i18n = vi.hoisted(() => ({ locale: "ru" }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ currentLocale: i18n.locale, t: (key: string) => key }),
}));

const { resolvePpmEditorText, usePpmEditorLanguage } = await import("@/components/editor/ppm-editor-language");
// The editor helper is a plain module without path aliases: loaded from source at run time (web's tsconfig only
// type-checks apps/web; the editor package type-checks it itself).
type TEditorHelper = {
  editorText: (key: string, upstream: string, values?: Record<string, string | number>) => string;
  setEditorTextResolver: (resolver: ((key: string) => string | undefined) | null) => void;
};
const editorHelper = (await import(
  /* @vite-ignore */ fileURLToPath(new URL("../../../../packages/editor/src/core/helpers/ppm-text.ts", import.meta.url))
)) as TEditorHelper;

const EDITOR_SRC = fileURLToPath(new URL("../../../../packages/editor/src/", import.meta.url));

afterEach(() => {
  editorHelper.setEditorTextResolver(null);
  editorResolver.current = null;
  i18n.locale = "ru";
});

describe("editorText (@plane/editor core/helpers/ppm-text)", () => {
  it("returns the upstream text byte for byte while no resolver is registered", () => {
    expect(editorHelper.editorText("ui.editor.bold", "Bold")).toBe("Bold");
    expect(
      editorHelper.editorText(
        "ui.editor.file_too_large",
        "File size too large. Please select a file smaller than 5MB.",
        { size: 5 }
      )
    ).toBe("File size too large. Please select a file smaller than 5MB.");
  });

  it("takes the registered text and fills its placeholders; an unknown key keeps the upstream text", () => {
    editorHelper.setEditorTextResolver(resolvePpmEditorText);
    expect(editorHelper.editorText("ui.editor.bold", "Bold")).toBe("Жирный");
    expect(editorHelper.editorText("ui.editor.placeholder_heading", "Heading 2", { level: 2 })).toBe("Заголовок 2");
    expect(editorHelper.editorText("ui.editor.file_too_large", "…", { size: 5 })).toBe(
      "Файл слишком большой. Выберите файл меньше 5 МБ."
    );
    expect(editorHelper.editorText("ui.editor.not_a_key", "Upstream")).toBe("Upstream");
    editorHelper.setEditorTextResolver(null);
    expect(editorHelper.editorText("ui.editor.bold", "Bold")).toBe("Bold");
  });
});

describe("usePpmEditorLanguage: the Russian editor texts only in the Russian PPM interface", () => {
  function Probe() {
    usePpmEditorLanguage();
    return null;
  }

  it("registers the PPM dictionary in Russian and clears it in any other language", () => {
    renderToStaticMarkup(<Probe />);
    expect(editorResolver.current?.("ui.editor.slash_text")).toBe("Обычный текст без оформления.");
    i18n.locale = "en";
    renderToStaticMarkup(<Probe />);
    expect(editorResolver.current).toBeNull();
  });

  it("with PPM_SHELL_ENABLED=0 the editor keeps its upstream texts in Russian too", async () => {
    vi.stubEnv("PPM_SHELL_ENABLED", "0");
    vi.resetModules();
    try {
      const module = await import("@/components/editor/ppm-editor-language");
      function ShellOffProbe() {
        module.usePpmEditorLanguage();
        return null;
      }
      editorResolver.current = () => "stale";
      renderToStaticMarkup(<ShellOffProbe />);
      expect(editorResolver.current).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

type TEditorTextCall = { file: string; line: number; key: string; upstream: string; template: boolean };

function editorTextCalls(): TEditorTextCall[] {
  const calls: TEditorTextCall[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
        const text = readFileSync(full, "utf8");
        if (!text.includes("editorText(")) continue;
        const kind = entry.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
        const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, kind);
        const visit = (node: ts.Node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.getText() === "editorText" &&
            !full.endsWith(path.join("helpers", "ppm-text.ts"))
          ) {
            const [key, upstream] = node.arguments;
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            calls.push({
              file: path.relative(EDITOR_SRC, full),
              line: line + 1,
              key: key && ts.isStringLiteral(key) ? key.text : `<not a literal: ${key?.getText()}>`,
              upstream:
                upstream && (ts.isStringLiteral(upstream) || ts.isNoSubstitutionTemplateLiteral(upstream))
                  ? upstream.text
                  : (upstream?.getText() ?? ""),
              template: !!upstream && ts.isTemplateExpression(upstream),
            });
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  };
  walk(EDITOR_SRC);
  return calls;
}

describe("every editorText call of the editor package", () => {
  const calls = editorTextCalls();
  const en = PPM_TRANSLATIONS.en as Record<string, string>;
  const ru = PPM_TRANSLATIONS.ru as Record<string, string>;

  it("covers the editor's own interface", () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(new Set(calls.map((call) => call.file)).size).toBeGreaterThan(20);
  });

  it.each(calls.map((call) => [`${call.file}:${call.line} ${call.key}`, call] as const))(
    "%s: a PPM key whose English is the upstream text",
    (_name, call) => {
      expect(call.key.startsWith("ui.editor."), call.key).toBe(true);
      expect(ru[call.key], call.key).toMatch(/[А-Яа-яЁё]/);
      if (call.template)
        // `Heading ${level}` ↔ "Heading {level}": the placeholder carries the same name as the template variable.
        expect(`\`${en[call.key].replace(/\{(\w+)\}/g, "${$1}")}\``).toBe(call.upstream);
      else expect(en[call.key]).toBe(call.upstream);
    }
  );
});
