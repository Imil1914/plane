// G2.3 (G-Web, G3): the pages "/" item «Коммит или PR» crosses a package boundary (packages/editor cannot import
// this app's service/dialogs), bridged the same way `setEditorTextResolver` already is (line R2) — a host-registered
// handler, no new ProseMirror node. Checked in source on both sides, like route-wiring.test.ts does for «Код», plus
// (review round 1 #1) a behavioral test against the real packages/editor source: the item must not be offered at
// all while no host has registered — every consumer of `RichTextEditor`/`DocumentEditor` shares the same slash-
// command list, but only pages/editor/editor-body.tsx mounts a host; before this fix, choosing the item anywhere
// else (e.g. a task description) silently deleted "/query" and inserted nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const editorExtended = readFileSync(
  new URL("../../../../packages/editor/src/ce/types/editor-extended.ts", import.meta.url),
  "utf8"
);
const g23Extension = readFileSync(
  new URL("../../../../packages/editor/src/ce/extensions/g23-insert-git-object.tsx", import.meta.url),
  "utf8"
);
const g23Bridge = readFileSync(
  new URL("../../../../packages/editor/src/ce/extensions/g23-insert-git-object-bridge.ts", import.meta.url),
  "utf8"
);
const slashCommands = readFileSync(
  new URL("../../../../packages/editor/src/ce/extensions/slash-commands.tsx", import.meta.url),
  "utf8"
);
const packageIndex = readFileSync(new URL("../../../../packages/editor/src/index.ts", import.meta.url), "utf8");
const slashHost = readFileSync(
  new URL("../../core/components/ppm-git/insert/insert-git-object-slash-host.tsx", import.meta.url),
  "utf8"
);
const editorBody = readFileSync(new URL("../../core/components/pages/editor/editor-body.tsx", import.meta.url), "utf8");

describe("packages/editor side of the bridge", () => {
  it("extends TExtendedEditorCommands with exactly the one new command key", () => {
    expect(editorExtended).toContain('export type TExtendedEditorCommands = "g23_insert_git_object";');
  });

  it("deletes the /query range, then hands the resulting cursor position to the bridge — no new node", () => {
    const start = g23Extension.indexOf("command: ({ editor, range }) => {");
    const end = g23Extension.indexOf('section: "general"');
    const body = g23Extension.slice(start, end);
    expect(body).toContain("editor.chain().focus().deleteRange(range).run();");
    expect(body).toContain("callG23InsertGitObjectHandler({ editor, pos: editor.state.selection.from });");
    expect(g23Extension).not.toMatch(/Node\.create|addNodeView|schema:/);
  });

  it("the bridge (JSX-free) holds the settable module-level handler, mirroring setEditorTextResolver", () => {
    expect(g23Bridge).toContain("export const setG23InsertGitObjectHandler");
    expect(g23Bridge).toContain("let g23InsertGitObjectHandler: TG23InsertGitObjectHandler | null = null;");
    expect(g23Bridge).toContain("export function hasG23InsertGitObjectHandler(): boolean {");
    expect(g23Bridge).toContain(
      "export function callG23InsertGitObjectHandler(context: TG23InsertGitObjectContext): void {"
    );
  });

  it("review round 1 (#1): offers the item only while hasG23InsertGitObjectHandler() is true", () => {
    expect(slashCommands).toContain('import { hasG23InsertGitObjectHandler } from "./g23-insert-git-object-bridge";');
    expect(slashCommands).toContain(
      "if (hasG23InsertGitObjectHandler()) options.push(createG23InsertGitObjectSlashOption());"
    );
    // Not present unconditionally any more — that was exactly the bug.
    expect(slashCommands).not.toMatch(/\[createG23InsertGitObjectSlashOption\(\)\]/);
  });

  it("is exported from the package's public entry point via the bridge, so the web app can import it from @plane/editor", () => {
    expect(packageIndex).toContain(
      'export { setG23InsertGitObjectHandler } from "@/plane-editor/extensions/g23-insert-git-object-bridge";'
    );
  });
});

describe("apps/web side of the bridge", () => {
  it("InsertGitObjectSlashHost registers on mount and unregisters on unmount (never leaks a stale handler)", () => {
    const start = slashHost.indexOf("useEffect(() => {");
    const end = slashHost.indexOf("if (!projectId");
    const body = slashHost.slice(start, end);
    expect(body).toContain("setG23InsertGitObjectHandler((context) => setPending(context));");
    expect(body).toContain("return () => setG23InsertGitObjectHandler(null);");
  });

  it("renders nothing until the slash command actually fires, and needs a projectId", () => {
    expect(slashHost).toContain("if (!projectId || !pending) return null;");
  });

  it("re-clamps the remembered position before inserting (the dialog's search is async, the doc may have changed)", () => {
    expect(slashHost).toContain("Math.max(0, Math.min(pos, editor.state.doc.content.size))");
  });

  it("is mounted once per page editor body, with the resolved workspace id (not the slug)", () => {
    expect(editorBody).toContain(
      'import { InsertGitObjectSlashHost } from "@/components/ppm-git/insert/insert-git-object-slash-host";'
    );
    expect(editorBody).toContain("<InsertGitObjectSlashHost projectId={projectId} workspaceId={workspaceId} />");
  });
});

// Review round 1 (#1): behavioral proof against the real packages/editor source (loaded directly, like
// tests/ppm-shell/r2-editor-text.test.tsx already does for ppm-text.ts — apps/web's tsconfig only type-checks
// apps/web, packages/editor type-checks itself; this suite exercises its runtime behavior, not its dist).
const BRIDGE_URL = new URL(
  "../../../../packages/editor/src/ce/extensions/g23-insert-git-object-bridge.ts",
  import.meta.url
);
const SLASH_COMMANDS_URL = new URL("../../../../packages/editor/src/ce/extensions/slash-commands.tsx", import.meta.url);

type TBridgeModule = {
  setG23InsertGitObjectHandler: (handler: (() => void) | null) => void;
};
type TSlashCommandsModule = {
  coreEditorAdditionalSlashCommandOptions: (props: {
    disabledExtensions: never[];
    flaggedExtensions: never[];
  }) => Array<{ commandKey: string }>;
};

const bridge = (await import(/* @vite-ignore */ fileURLToPath(BRIDGE_URL))) as TBridgeModule;
const slashCommandsModule = (await import(
  /* @vite-ignore */ fileURLToPath(SLASH_COMMANDS_URL)
)) as TSlashCommandsModule;

function hasGitObjectItem(): boolean {
  const options = slashCommandsModule.coreEditorAdditionalSlashCommandOptions({
    disabledExtensions: [],
    flaggedExtensions: [],
  });
  return options.some((item) => item.commandKey === "g23_insert_git_object");
}

describe("coreEditorAdditionalSlashCommandOptions — scope (review round 1 #1)", () => {
  afterEach(() => {
    bridge.setG23InsertGitObjectHandler(null);
  });

  it("does not offer «Коммит или PR» when no host has registered a handler (e.g. a task description editor)", () => {
    expect(hasGitObjectItem()).toBe(false);
  });

  it("offers it once a host registers (e.g. the pages editor body's InsertGitObjectSlashHost)", () => {
    bridge.setG23InsertGitObjectHandler(() => {});
    expect(hasGitObjectItem()).toBe(true);
  });

  it("stops offering it again once the host unregisters on unmount", () => {
    bridge.setG23InsertGitObjectHandler(() => {});
    expect(hasGitObjectItem()).toBe(true);
    bridge.setG23InsertGitObjectHandler(null);
    expect(hasGitObjectItem()).toBe(false);
  });
});
