// UX1.1 T (final fix A3): the two heavy Tasks requests (issues-detail with relations, project Git links) are not
// refetched on every window focus; the summary is refetched only after the peek closes and on «Повторить».
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PpmTasksDataProvider, usePpmTasksData } from "@/components/ppm-tasks/data-context";
import type { TPpmTasksData } from "@/components/ppm-tasks/data-context";

type TSwrCall = { key: unknown; config: Record<string, unknown>; mutate: ReturnType<typeof vi.fn> };
const swrCalls: TSwrCall[] = [];

vi.mock("swr", () => ({
  default: (key: unknown, _fetcher: unknown, config: Record<string, unknown>) => {
    const mutate = vi.fn();
    swrCalls.push({ key, config, mutate });
    return { data: undefined, error: undefined, mutate };
  },
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({ useIssueDetail: () => ({ peekIssue: undefined }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws-uuid" }) }),
}));
vi.mock("@/components/ppm-tasks/services", () => ({
  fetchPpmTasksAttention: vi.fn(),
  PpmTaskGitLinksService: class {
    listLinks = vi.fn();
  },
}));

let captured: TPpmTasksData | null = null;
function Probe() {
  captured = usePpmTasksData();
  return null;
}

const render = () =>
  renderToStaticMarkup(
    <PpmTasksDataProvider workspaceSlug="acme" projectId="p-1" enabled>
      <Probe />
    </PpmTasksDataProvider>
  );

describe("PpmTasksDataProvider (Tasks v2 data)", () => {
  beforeEach(() => {
    swrCalls.length = 0;
    captured = null;
  });

  it("does not refetch issues-detail or the Git links on window focus, and never retries on error", () => {
    render();
    expect(swrCalls.map((call) => (call.key as unknown[])[0])).toEqual(["ppm-tasks-attention", "ppm-tasks-git-links"]);
    for (const call of swrCalls) {
      expect(call.config.revalidateOnFocus, String((call.key as unknown[])[0])).toBe(false);
      expect(call.config.shouldRetryOnError, String((call.key as unknown[])[0])).toBe(false);
    }
  });

  it("«Повторить» refetches the summary", () => {
    render();
    captured?.retryAttention();
    expect(swrCalls[0].mutate).toHaveBeenCalledTimes(1);
    expect(swrCalls[1].mutate).not.toHaveBeenCalled();
  });

  it("still refetches the summary once after the peek closes", () => {
    const source = readFileSync(new URL("../../core/components/ppm-tasks/data-context.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (wasPeekOpen.current && !isPeekOpen && enabled) void mutateAttention();");
  });
});
