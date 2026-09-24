import { describe, expect, it } from "vitest";
import { toWorkspaceSlug } from "@/helpers/workspace-slug.helper";

describe("workspace URL normalization", () => {
  it("transliterates a Russian workspace name", () => {
    expect(toWorkspaceSlug("Тест _1")).toBe("test-_1");
  });

  it("keeps only URL-safe characters", () => {
    expect(toWorkspaceSlug("  Проект № 42!  ")).toBe("proekt-42");
  });

  it("normalizes accented Latin characters", () => {
    expect(toWorkspaceSlug("Équipe Démo")).toBe("equipe-demo");
  });

  it("limits the URL part to the server maximum", () => {
    expect(toWorkspaceSlug("а".repeat(60))).toHaveLength(48);
  });
});
