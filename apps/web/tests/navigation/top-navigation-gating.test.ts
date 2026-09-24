// UX0.2 final fix F4: the narrow-screen top navigation (Power K search field hidden below `sm`, replaced by a
// search icon button; shrinkable workspace menu) is PPM shell behaviour. With PPM_SHELL_ENABLED=0 the top
// navigation must render the upstream arrangement unchanged.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../core/components/navigation/top-navigation-root.tsx", import.meta.url),
  "utf8"
);

describe("top navigation narrow-screen layout is gated on the PPM shell", () => {
  it("keeps the upstream Power K wrapper when the shell is off", () => {
    expect(source).toMatch(/className=\{isPpmShell \? "hidden shrink-0 sm:block" : "shrink-0"\}>\s*<TopNavPowerK \/>/);
  });

  it("renders the narrow-screen search icon button only in the PPM shell", () => {
    expect(source).toMatch(/\{isPpmShell && \(\s*<IconButton\s+className="sm:hidden"/);
  });

  it("keeps the upstream container and workspace-menu classes when the shell is off", () => {
    expect(source).toMatch(/"min-w-0 gap-1": isPpmShell/);
    expect(source).toMatch(/className=\{isPpmShell \? "min-w-0 flex-1" : "flex-1 shrink-0"\}>\s*<WorkspaceMenuRoot/);
  });
});
