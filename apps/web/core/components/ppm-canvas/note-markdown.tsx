/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useContext, useMemo, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { FileText, ListTodo, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { stopEventPropagation, useValue, type Editor, type TLShapeId } from "tldraw";
import { parseSerializedPpmCanvasNode, type TPpmCanvasOwnedNode } from "@ppm/canvas";
import { resolveGeneralTheme } from "@plane/utils";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { OWN_NODE_KIND_KEYS } from "./canvas-grammar";
import { PpmCanvasContentActionsContext } from "./canvas-content-actions";
import { canvasMarkdownPlainReason, noteTaskName, renderCanvasMarkdown, sanitizeCanvasHtml } from "./canvas-markdown";
import { canScrollBy } from "./canvas-placement";
import { startEditingShape } from "./canvas-toolkit-actions";
import { OwnNodeGlyph } from "./live-card";
import type { TPpmCanvasShape } from "./shape";
// oxlint-disable-next-line import/no-unassigned-import -- KaTeX: стили и шрифты собирает Vite локально (без CDN)
import "katex/dist/katex.min.css";

type TNoteNode = Extract<TPpmCanvasOwnedNode, { kind: "note" }>;

/**
 * Финальная волна (решение контроллера): новая заметка v2 сразу открывается в правке, как стикер (createPpmSticky).
 * Создание — свой шаг истории; затем то же состояние tldraw, что после двойного щелчка (select.editing_shape): поле
 * текста получает фокус (autoFocus ниже), выход — Esc, ⌘/Ctrl+Enter или щелчок мимо. Старая (plain) заметка сюда
 * не попадает: её рисует прежняя карточка, правка ей не нужна. Облик v1 эту функцию не зовёт (editor.tsx).
 */
export function createNoteInEditMode(editor: Editor, create: () => TLShapeId): TLShapeId {
  editor.markHistoryStoppingPoint("ppm add note");
  const id = create();
  const shape = editor.getShape<TPpmCanvasShape>(id);
  const parsed = shape ? parseSerializedPpmCanvasNode(shape.props.node) : undefined;
  if (
    (parsed?.status === "valid" || parsed?.status === "migrated") &&
    parsed.node.kind === "note" &&
    parsed.node.format === "markdown"
  )
    startEditingShape(editor, id);
  return id;
}

// AF2.1 B1 (K3): заметка — отрисованный Markdown с формулами; двойной клик или Enter — правка (состояние
// редактирования tldraw), Esc или ⌘/Ctrl+Enter — обратно. «Сделать задачей» / «Сделать документом» — живые
// источники рядом с заметкой (I1/I2).
export function NoteCardV2({
  editor,
  node,
  onPatch,
  shape,
}: {
  editor: Editor;
  node: TNoteNode;
  onPatch: (patch: Partial<Pick<TNoteNode, "body" | "title">>) => void;
  shape: TPpmCanvasShape;
}) {
  const ppmT = usePpmTranslation();
  const actions = useContext(PpmCanvasContentActionsContext);
  const readonly = editor.getInstanceState().isReadonly;
  const editing = useValue("ppm note editing", () => editor.getEditingShapeId() === shape.id, [editor, shape.id]);
  const [busy, setBusy] = useState<"document" | "task">();
  const canAct = actions.canEdit && !readonly;
  const { resolvedTheme } = useTheme();
  const codeTheme = resolveGeneralTheme(resolvedTheme) === "dark" ? "dark" : "light";

  const run = async (kind: "document" | "task") => {
    if (busy || !canAct) return;
    const name = noteTaskName(node.title, node.body) || ppmT("canvas.note_untitled");
    setBusy(kind);
    try {
      if (kind === "task") await actions.createTaskFromText(shape, name);
      else await actions.createPageFromNote(shape, name, node.body);
    } finally {
      setBusy(undefined);
    }
  };

  const onSourceKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    event.stopPropagation();
    if (event.code === "Escape" || (event.code === "Enter" && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      // Через машину состояний tldraw (как его текстовые фигуры): select.editing_shape → idle. Esc tldraw уже
      // обработал на своём контейнере (editor.cancel()) — тогда правка закончена и здесь ничего не делаем.
      if (editor.getEditingShapeId() === shape.id) editor.complete();
    }
  };

  return (
    <div className="ppm-note-card" data-code-theme={codeTheme} data-editing={editing && !readonly ? true : undefined}>
      <header className="ppm-note-card__header">
        <span className="ppm-canvas-node__type">
          <OwnNodeGlyph kind="note" />
          {ppmT(OWN_NODE_KIND_KEYS.note)}
        </span>
        {canAct && (
          <div className="ppm-note-card__actions">
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void run("task")}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              {busy === "task" ? <LoaderCircle aria-hidden="true" /> : <ListTodo aria-hidden="true" />}
              {ppmT("canvas.note_make_task")}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void run("document")}
              onKeyDown={stopEventPropagation}
              onPointerDown={stopEventPropagation}
            >
              {busy === "document" ? <LoaderCircle aria-hidden="true" /> : <FileText aria-hidden="true" />}
              {ppmT("canvas.note_make_document")}
            </button>
          </div>
        )}
      </header>
      {editing && !readonly ? (
        <>
          <input
            aria-label={ppmT("canvas.note_title_placeholder")}
            className="ppm-note-card__title-input"
            maxLength={160}
            placeholder={ppmT("canvas.note_title_placeholder")}
            value={node.title}
            onChange={(event) => onPatch({ title: event.currentTarget.value })}
            onKeyDown={onSourceKeyDown}
            onPointerDown={stopEventPropagation}
          />
          <textarea
            // oxlint-disable-next-line jsx_a11y/no-autofocus -- правка начинается двойным кликом, Enter или сразу у новой заметки
            autoFocus
            aria-label={ppmT("canvas.note_body_placeholder")}
            className="ppm-note-card__source"
            maxLength={50_000}
            placeholder={ppmT("canvas.note_body_placeholder")}
            spellCheck
            value={node.body}
            onChange={(event) => onPatch({ body: event.currentTarget.value })}
            onKeyDown={onSourceKeyDown}
            onPointerDown={stopEventPropagation}
            onWheelCapture={stopEventPropagation}
          />
          <small className="ppm-note-card__hint">{ppmT("canvas.note_markdown_hint")}</small>
        </>
      ) : (
        <>
          {node.title.trim() && <h3 className="ppm-note-card__title">{node.title}</h3>}
          {node.body.trim() ? (
            <NoteBodyView body={node.body} />
          ) : (
            // Подсказка «Дважды щёлкните…» — только тому, кто может писать.
            canAct && <p className="ppm-note-card__empty">{ppmT("canvas.note_empty")}</p>
          )}
        </>
      )}
    </div>
  );
}

// Ссылка внутри отрисованного текста должна открываться, а не начинать перетаскивание карточки.
function onViewPointerDown(event: PointerEvent<HTMLDivElement>) {
  if ((event.target as HTMLElement).closest("a")) event.stopPropagation();
}

// Колесо над заметкой, которую есть куда листать, листает её (формулу или код — по горизонтали), а не двигает холст.
// Фаза перехвата: обработчик колеса tldraw висит на .tl-canvas (ниже корня React) — всплытие до React не дошло бы.
// Жест масштаба (⌘/Ctrl) и упор в край — холсту.
function onViewWheel(event: WheelEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey) return;
  const horizontal = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
  const wide = (event.target as HTMLElement).closest<HTMLElement>(".ppm-note-math, .ppm-note-code");
  if (wide && horizontal !== 0 && canScrollBy(wide.scrollLeft, wide.clientWidth, wide.scrollWidth, horizontal)) {
    event.stopPropagation();
    return;
  }
  const box = event.currentTarget;
  if (!event.shiftKey && canScrollBy(box.scrollTop, box.clientHeight, box.scrollHeight, event.deltaY)) {
    event.stopPropagation();
  }
}

// Решения контроллера: больше 10 000 знаков (раунд 1) или разметка, которую marked разбирал бы секундами (раунд 2), —
// текстом, без разбора и без обрезки, с подписью о причине.
function NoteBodyView({ body }: { body: string }) {
  const ppmT = usePpmTranslation();
  const plainReason = useMemo(() => canvasMarkdownPlainReason(body), [body]);
  if (!plainReason) return <NoteMarkdownView body={body} />;
  return (
    <>
      <p className="ppm-note-card__notice">
        {ppmT(plainReason === "length" ? "canvas.note_too_long" : "canvas.note_too_complex")}
      </p>
      <div className="ppm-note-plain" onWheelCapture={onViewWheel}>
        {body}
      </div>
    </>
  );
}

// Разбор Markdown живёт только в режиме просмотра: во время правки он не повторяется на каждое нажатие клавиши.
// renderCanvasMarkdown не бросает: ошибка разбора (язык кода, формула…) даёт экранированный текст, а не падение карточки.
function NoteMarkdownView({ body }: { body: string }) {
  const html = useMemo(() => sanitizeCanvasHtml(renderCanvasMarkdown(body)), [body]);
  return (
    <div
      className="ppm-note-markdown"
      // HTML прошёл sanitizeCanvasHtml (DOMPurify) — см. useMemo выше.
      dangerouslySetInnerHTML={{ __html: html }}
      onPointerDown={onViewPointerDown}
      onWheelCapture={onViewWheel}
    />
  );
}
