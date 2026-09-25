/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Copy, Download, Ellipsis, Lock, LockOpen, Moon, Sun, SunMoon, WrapText } from "lucide-react";
import { useTheme } from "next-themes";
import { stopEventPropagation, useValue, type Editor } from "tldraw";
import type { TPpmCanvasOwnedNode } from "@ppm/canvas";
import { resolveGeneralTheme } from "@plane/utils";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import {
  CANVAS_CODE_LANGUAGES,
  codeDownloadName,
  codeLanguageLabel,
  highlightCodeLines,
  insertSoftTab,
  nextCodeTheme,
  normalizeCodeLanguage,
  resolveCodeTheme,
} from "./canvas-code";
import type { TPpmCanvasShape } from "./shape";

type TCodeNode = Extract<TPpmCanvasOwnedNode, { kind: "code" }>;
export type TCodePatch = Partial<Pick<TCodeNode, "code" | "language" | "locked" | "theme" | "title" | "wrap">>;

const THEME_LABEL_KEYS = {
  auto: "canvas.code_theme_auto",
  dark: "canvas.code_theme_dark",
  light: "canvas.code_theme_light",
} as const;

export type TCodeControlState = { controlsDisabled: boolean; lockDisabled: boolean };

// Controller ruling: a locked block doesn't change for anyone until it's unlocked, so theme/language/wrap follow
// readonly OR the block's own lock. The lock toggle itself only follows readonly — an editor must always be able
// to unlock a block (their own or someone else's). Copy/Download are never gated here (available to everyone).
export function codeControlState(readonly: boolean, locked: boolean): TCodeControlState {
  return { controlsDisabled: readonly || locked, lockDisabled: readonly };
}

// AF2.1 B2 (K3): блок кода — номера строк, подсветка lowlight, тема блока, замок, «…». Код только хранится и
// показывается (executable: false в схеме): никакого eval/innerHTML — подсветка собирается React-элементами.
export function CodeBlockCard({
  editor,
  node,
  onPatch,
  shape,
}: {
  editor: Editor;
  node: TCodeNode;
  onPatch: (patch: TCodePatch) => void;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const { resolvedTheme } = useTheme();
  const readonly = editor.getInstanceState().isReadonly;
  const controlState = codeControlState(readonly, node.locked);
  const locked = controlState.controlsDisabled;
  const editingShape = useValue("ppm code editing", () => editor.getEditingShapeId() === shape.id, [editor, shape.id]);
  const editing = editingShape && !locked;
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const language = normalizeCodeLanguage(node.language);
  // A bad language/grammar must never break the card: fall back to plain, unstyled lines (React escapes JSX text
  // itself — no HTML string is produced here, unlike highlightCodeHtml for notes).
  const lines = useMemo(() => {
    try {
      return highlightCodeLines(node.code, language);
    } catch {
      return node.code.split("\n").map((line) => (line ? [{ className: "", text: line }] : []));
    }
  }, [language, node.code]);
  const theme = resolveCodeTheme(node.theme, resolveGeneralTheme(resolvedTheme) === "dark");

  // «…» menu: closes on an outside pointerdown and on Escape (captured on `document` so it fires before tldraw's
  // own container-level Escape handling — every toolbar button already stops propagation of its own pointerdown,
  // which would otherwise defeat a bubble-phase listener; capture on `document` runs ahead of all of that).
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDownOutside = (event: PointerEvent) => {
      if (!menuAnchorRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDownCapture = (event: globalThis.KeyboardEvent) => {
      if (event.code !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setMenuOpen(false);
      menuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDownOutside, true);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownOutside, true);
      document.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [menuOpen]);

  // Menu items close the menu themselves (Escape and outside-click are handled by the effect above); each closing
  // path returns focus to the «…» trigger, as a menu-button pattern does.
  const closeMenu = () => {
    setMenuOpen(false);
    menuTriggerRef.current?.focus();
  };

  const onSourceKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.code === "Tab") {
      event.preventDefault();
      const target = event.currentTarget;
      const next = insertSoftTab(target.value, target.selectionStart, target.selectionEnd, event.shiftKey);
      onPatch({ code: next.value });
      requestAnimationFrame(() => target.setSelectionRange(next.start, next.end));
      return;
    }
    if (event.code === "Escape" || (event.code === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      editor.setEditingShape(null);
    }
  };

  const copy = async () => {
    closeMenu();
    try {
      await navigator.clipboard.writeText(node.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    closeMenu();
    const url = URL.createObjectURL(new Blob([node.code], { type: "text/plain;charset=utf-8" }));
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = codeDownloadName(node.title, language);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ppm-code-block" data-locked={node.locked || undefined} data-theme={theme}>
      <header className="ppm-code-block__toolbar">
        <button
          type="button"
          className="ppm-code-block__tool"
          aria-label={`${ppmT("canvas.code_theme")}: ${ppmT(THEME_LABEL_KEYS[node.theme])}`}
          title={`${ppmT("canvas.code_theme")}: ${ppmT(THEME_LABEL_KEYS[node.theme])}`}
          disabled={controlState.controlsDisabled}
          onClick={() => onPatch({ theme: nextCodeTheme(node.theme) })}
          onPointerDown={stopEventPropagation}
        >
          {node.theme === "dark" ? (
            <Moon aria-hidden="true" />
          ) : node.theme === "light" ? (
            <Sun aria-hidden="true" />
          ) : (
            <SunMoon aria-hidden="true" />
          )}
        </button>
        <select
          aria-label={ppmT("canvas.code_language")}
          className="ppm-code-block__language"
          disabled={controlState.controlsDisabled}
          value={language}
          onChange={(event) => onPatch({ language: event.currentTarget.value })}
          onKeyDown={stopEventPropagation}
          onPointerDown={stopEventPropagation}
        >
          {CANVAS_CODE_LANGUAGES.map((id) => (
            <option key={id} value={id}>
              {codeLanguageLabel(id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ppm-code-block__tool"
          aria-label={ppmT("canvas.code_lock")}
          aria-pressed={node.locked}
          title={ppmT(node.locked ? "canvas.code_locked_hint" : "canvas.code_lock")}
          disabled={controlState.lockDisabled}
          onClick={() => onPatch({ locked: !node.locked })}
          onPointerDown={stopEventPropagation}
        >
          {node.locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
        </button>
        <div className="ppm-code-block__menu-anchor" ref={menuAnchorRef}>
          <button
            type="button"
            className="ppm-code-block__tool"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={ppmT("canvas.code_more")}
            ref={menuTriggerRef}
            onClick={() => setMenuOpen((open) => !open)}
            onPointerDown={stopEventPropagation}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="ppm-code-block__menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void copy()} onPointerDown={stopEventPropagation}>
                <Copy aria-hidden="true" />
                {ppmT("canvas.code_copy")}
              </button>
              <button type="button" role="menuitem" onClick={download} onPointerDown={stopEventPropagation}>
                <Download aria-hidden="true" />
                {ppmT("canvas.code_download")}
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={node.wrap}
                disabled={controlState.controlsDisabled}
                onClick={() => {
                  closeMenu();
                  onPatch({ wrap: !node.wrap });
                }}
                onPointerDown={stopEventPropagation}
              >
                <WrapText aria-hidden="true" />
                {ppmT("canvas.code_wrap")}
              </button>
            </div>
          )}
        </div>
        {copied && (
          <span className="ppm-code-block__copied" role="status">
            {ppmT("canvas.code_copied")}
          </span>
        )}
      </header>
      <div
        className="ppm-code-block__body"
        data-wrap={node.wrap || undefined}
        onWheelCapture={editing ? stopEventPropagation : undefined}
      >
        <ol className="ppm-code-block__gutter" aria-hidden="true">
          {lines.map((_, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- line number rows: always fully re-derived from code/language, order is the content
            <li key={index}>{index + 1}</li>
          ))}
        </ol>
        <div className="ppm-code-block__code">
          <pre aria-label={codeLanguageLabel(language)}>
            <code>
              {lines.map((line, lineIndex) => (
                // oxlint-disable-next-line react/no-array-index-key -- highlighted lines: always fully re-derived from code/language, order is the content
                <span className="ppm-code-block__line" key={lineIndex}>
                  {line.map((segment, segmentIndex) => (
                    // oxlint-disable-next-line react/no-array-index-key -- highlight segments: always fully re-derived, no stable identity besides position
                    <span className={segment.className || undefined} key={segmentIndex}>
                      {segment.text}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>
          {editing && (
            <textarea
              // oxlint-disable-next-line jsx_a11y/no-autofocus -- правка начинается двойным кликом или Enter
              autoFocus
              aria-label={ppmT("canvas.code_body_placeholder")}
              className="ppm-code-block__source"
              maxLength={100_000}
              spellCheck={false}
              value={node.code}
              wrap={node.wrap ? "soft" : "off"}
              onChange={(event) => onPatch({ code: event.currentTarget.value })}
              onKeyDown={onSourceKeyDown}
              onPointerDown={stopEventPropagation}
            />
          )}
        </div>
      </div>
    </div>
  );
}
