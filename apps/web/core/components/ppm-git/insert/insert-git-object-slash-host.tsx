// G2.3 (line G-Web, G3): bridges the pages "/" item «Коммит или PR» (packages/editor/src/ce/extensions/
// g23-insert-git-object.tsx) to this dialog. Mount once per page editor (editor-body.tsx) — it renders nothing of its
// own until the slash command fires, then opens the same dialog the toolbar button uses, and inserts the resulting
// link with the raw Tiptap `editor` + cursor position the slash command handed over (not `EditorRefApi`, since the
// package only has the Tiptap `Editor` instance at that point).
import { useEffect, useState } from "react";
import { setG23InsertGitObjectHandler } from "@plane/editor";
import type { TG23InsertGitObjectContext } from "@plane/editor";
import { buildGitObjectHtmlLink } from "./format";
import { InsertGitObjectDialog } from "./insert-git-object-dialog";

export type TInsertGitObjectSlashHostProps = {
  workspaceId: string;
  projectId: string | undefined;
};

// The Tiptap `Editor` type is taken from `TG23InsertGitObjectContext` itself (packages/editor's own resolution of
// `@tiptap/core`), not re-imported from `@tiptap/core` directly here: pnpm hoists a second, separate copy of
// `@tiptap/core` at the workspace root, and TypeScript treats the two copies' `Editor` (a class with private fields)
// as structurally distinct types — importing it a second time causes TS2345 ("separate declarations of a private
// property") the moment it is passed where the context's own `editor` is expected.
type TPendingEditor = TG23InsertGitObjectContext["editor"];

/** Re-checks bounds before inserting: the dialog's search is async, so the document may have grown/shrunk while it
 * was open. */
function insertAt(editor: TPendingEditor, pos: number, html: string) {
  const safePos = Math.max(0, Math.min(pos, editor.state.doc.content.size));
  editor.chain().focus().insertContentAt(safePos, html).run();
}

export function InsertGitObjectSlashHost({ workspaceId, projectId }: TInsertGitObjectSlashHostProps) {
  const [pending, setPending] = useState<TG23InsertGitObjectContext | null>(null);

  useEffect(() => {
    setG23InsertGitObjectHandler((context) => setPending(context));
    return () => setG23InsertGitObjectHandler(null);
  }, []);

  if (!projectId || !pending) return null;

  return (
    <InsertGitObjectDialog
      open
      workspaceId={workspaceId}
      projectId={projectId}
      onClose={() => setPending(null)}
      onInsert={({ label, url }) => {
        insertAt(pending.editor, pending.pos, buildGitObjectHtmlLink(label, url));
        setPending(null);
      }}
    />
  );
}
