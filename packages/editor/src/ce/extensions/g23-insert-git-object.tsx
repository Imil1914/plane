/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// G2.3 (line G-Web): the "/" slash-menu item «Коммит или PR» on pages. This package cannot reach the web app's
// search service, MobX stores or dialog components, so — exactly like `setEditorTextResolver` in
// `core/helpers/ppm-text.ts` (line R2) — the web app registers a single handler here once, and the slash command
// only calls it. No new ProseMirror node: the item deletes its own "/query" text and hands the resulting cursor
// position to the handler, which inserts a plain `<a>` link already supported by the schema — so `apps/live`'s
// `core-without-props.ts` needs no change.
//
// The handler get/set/call bridge itself lives in g23-insert-git-object-bridge.ts (no JSX) — see that file for why
// (review round 1 #1): `coreEditorAdditionalSlashCommandOptions` (slash-commands.tsx) needs to check
// `hasG23InsertGitObjectHandler()` before ever calling this factory, so the two must not be entangled with the icon's
// JSX.
import { GitCommitHorizontal } from "lucide-react";
// helpers
import { editorText } from "@/helpers/ppm-text";
// local types
import type { TSlashCommandAdditionalOption } from "@/extensions";
import { callG23InsertGitObjectHandler } from "./g23-insert-git-object-bridge";

export function createG23InsertGitObjectSlashOption(): TSlashCommandAdditionalOption {
  return {
    commandKey: "g23_insert_git_object",
    key: "g23-insert-git-object",
    // Keys follow the package-wide `ui.editor.*`/`ui.editor.slash_*` convention (title/description pair, same as
    // every other slash item, e.g. "ui.editor.text"/"ui.editor.slash_text") — enforced by
    // apps/web/tests/ppm-shell/r2-editor-text.test.tsx, which scans every `editorText(...)` call in this package.
    title: editorText("ui.editor.git_object", "Commit or PR"),
    description: editorText("ui.editor.slash_git_object", "Insert a link to a commit or pull request"),
    searchTerms: ["git", "commit", "pr", "pull", "request", "коммит", "пиар", "пул", "реквест"],
    icon: <GitCommitHorizontal className="size-3.5" />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      callG23InsertGitObjectHandler({ editor, pos: editor.state.selection.from });
    },
    section: "general",
    pushAfter: "emoji",
  };
}
