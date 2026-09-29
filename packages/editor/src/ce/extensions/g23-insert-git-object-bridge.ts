/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// G2.3 (line G-Web, review round 1 #1): the host-registered handler for the "/" item «Коммит или PR», split out of
// g23-insert-git-object.tsx (JSX) so it can be imported and exercised without a JSX/TSX transform — this bridge is
// the only piece `slash-commands.tsx` needs to decide whether to *offer* the item at all.
//
// Only `pages/editor/editor-body.tsx` mounts `InsertGitObjectSlashHost`, which is the only thing that ever calls
// `setG23InsertGitObjectHandler`. Every other consumer of `RichTextEditor`/`DocumentEditor` (task description on its
// page, task description in the issue-creation modal, etc.) shares the *same* slash-command list — before this fix,
// they would show "Коммит или PR" too, and selecting it would silently delete the "/query" text and insert nothing
// (the handler was null). `hasG23InsertGitObjectHandler()` lets `coreEditorAdditionalSlashCommandOptions` leave the
// item out entirely wherever no host has registered, instead of offering a dead menu entry.
import type { Editor } from "@tiptap/core";

export type TG23InsertGitObjectContext = {
  editor: Editor;
  /** Where to insert the chosen link — the position left behind after the "/query" text was removed. */
  pos: number;
};

export type TG23InsertGitObjectHandler = (context: TG23InsertGitObjectContext) => void;

let g23InsertGitObjectHandler: TG23InsertGitObjectHandler | null = null;

/** Registers (or, with `null`, removes) the host app's «Вставить коммит/PR» dialog opener. */
export const setG23InsertGitObjectHandler = (handler: TG23InsertGitObjectHandler | null): void => {
  g23InsertGitObjectHandler = handler;
};

/** Whether a host is currently registered — the "/" item is offered only while this is true. */
export function hasG23InsertGitObjectHandler(): boolean {
  return g23InsertGitObjectHandler !== null;
}

/** Invokes the registered handler, if any; a no-op (not an error) when nothing is registered — callers that care
 * whether the item should be offered at all check `hasG23InsertGitObjectHandler()` beforehand. */
export function callG23InsertGitObjectHandler(context: TG23InsertGitObjectContext): void {
  g23InsertGitObjectHandler?.(context);
}
