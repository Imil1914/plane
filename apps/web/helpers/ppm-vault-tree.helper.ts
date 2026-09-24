// Keyboard model for the Vault tree (WAI-ARIA APG "tree view"): a flat list of treeitems with
// aria-level, so the tree needs no nested role="group" wrappers.

export type TVaultTreeSource = {
  id: string;
  name: string;
  kind: string;
  children?: readonly TVaultTreeSource[];
};

export type TFlatVaultNode<T extends TVaultTreeSource = TVaultTreeSource> = {
  id: string;
  entry: T;
  /** 1-based depth, ready for aria-level. */
  level: number;
  parentId?: string;
  hasChildren: boolean;
  expanded: boolean;
};

export type TVaultTreeKeyAction = "next" | "prev" | "first" | "last" | "expand" | "collapse" | "parent" | "select";

/** Visible rows in display order: children of a node are listed only while it is expanded. */
export function flattenVaultTree<T extends TVaultTreeSource>(
  tree: readonly T[],
  expanded: ReadonlySet<string>
): TFlatVaultNode<T>[] {
  const visit = (nodes: readonly T[], level: number, parentId?: string): TFlatVaultNode<T>[] =>
    nodes.flatMap((entry) => {
      const children = (entry.children ?? []) as readonly T[];
      const hasChildren = children.length > 0;
      const isExpanded = hasChildren && expanded.has(entry.id);
      const row: TFlatVaultNode<T> = { id: entry.id, entry, level, parentId, hasChildren, expanded: isExpanded };
      return isExpanded ? [row, ...visit(children, level + 1, entry.id)] : [row];
    });
  return visit(tree, 1);
}

/** Maps a physical key (KeyboardEvent.code) on a focused row to a tree action. */
export function getVaultTreeKeyAction(code: string, node: TFlatVaultNode): TVaultTreeKeyAction | null {
  switch (code) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowRight":
      if (!node.hasChildren) return null;
      // An open node moves focus to its first child, which is the next visible row.
      return node.expanded ? "next" : "expand";
    case "ArrowLeft":
      if (node.expanded) return "collapse";
      return node.parentId ? "parent" : null;
    case "Enter":
    case "NumpadEnter":
    case "Space":
      return "select";
    default:
      return null;
  }
}
