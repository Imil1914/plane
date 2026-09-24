import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenVaultTree, getVaultTreeKeyAction } from "@/helpers/ppm-vault-tree.helper";

const tree = [
  {
    id: "a",
    name: "Документы",
    kind: "folder",
    children: [{ id: "b", name: "ТЗ.md", kind: "file", children: [] }],
  },
  { id: "c", name: "Схема.pdf", kind: "file", children: [] },
];

describe("PPM vault tree navigation", () => {
  it("flattens expanded folders with levels", () => {
    expect(flattenVaultTree(tree, new Set(["a"])).map((n) => [n.id, n.level])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]);
    expect(flattenVaultTree(tree, new Set()).map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("keeps parent links and the expanded state of each row", () => {
    const [folder, child, file] = flattenVaultTree(tree, new Set(["a"]));
    expect(folder).toMatchObject({ hasChildren: true, expanded: true, parentId: undefined });
    expect(child).toMatchObject({ hasChildren: false, expanded: false, parentId: "a" });
    expect(file).toMatchObject({ hasChildren: false, expanded: false, parentId: undefined });
    expect(flattenVaultTree(tree, new Set())[0]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it("maps keys by physical code", () => {
    const folder = flattenVaultTree(tree, new Set(["a"]))[0];
    expect(getVaultTreeKeyAction("ArrowDown", folder)).toBe("next");
    expect(getVaultTreeKeyAction("ArrowLeft", folder)).toBe("collapse");
    expect(getVaultTreeKeyAction("Enter", folder)).toBe("select");
    expect(getVaultTreeKeyAction("KeyQ", folder)).toBeNull();
  });

  it("follows the tree pattern for arrows, Home, End and Space", () => {
    const [expandedFolder, child, rootFile] = flattenVaultTree(tree, new Set(["a"]));
    const collapsedFolder = flattenVaultTree(tree, new Set())[0];
    expect(getVaultTreeKeyAction("ArrowUp", child)).toBe("prev");
    expect(getVaultTreeKeyAction("Home", child)).toBe("first");
    expect(getVaultTreeKeyAction("End", child)).toBe("last");
    expect(getVaultTreeKeyAction("Space", child)).toBe("select");
    expect(getVaultTreeKeyAction("NumpadEnter", child)).toBe("select");
    expect(getVaultTreeKeyAction("ArrowRight", collapsedFolder)).toBe("expand");
    expect(getVaultTreeKeyAction("ArrowRight", expandedFolder)).toBe("next");
    expect(getVaultTreeKeyAction("ArrowRight", child)).toBeNull();
    expect(getVaultTreeKeyAction("ArrowLeft", collapsedFolder)).toBeNull();
    expect(getVaultTreeKeyAction("ArrowLeft", child)).toBe("parent");
    expect(getVaultTreeKeyAction("ArrowLeft", rootFile)).toBeNull();
  });
});

// UX0.2 final fix F5: the tree's accessible name comes from @ppm/brand (en «Project storage», ru «Хранилище
// проекта», which e2e/ppm-demo.spec.ts matches), not from a hardcoded Russian literal.
describe("PPM vault tree accessible name", () => {
  it("is translated through the vault.tree_label key", () => {
    const source = readFileSync(new URL("../../core/components/ppm-vault/route.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/role="tree" aria-label=\{ppmT\("vault\.tree_label"\)\}/);
    expect(source).not.toMatch(/aria-label="Хранилище проекта"/);
  });
});
