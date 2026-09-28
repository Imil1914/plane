// G2.1 fix round 1: «На холст» for objects of our Git server. The canvas services parse the projection the API
// returns (`display.provider = repository.provider`, now also `forgejo`): a single card (bindGit), the board refresh
// (getBindings) and the «Не на карте» pack (bindBatch) — one Forgejo PR used to fail zod and the whole request with it.
// The Git card names our Git server «Наш Git-сервер»; GitHub keeps its RC.1 label «GITHUB».
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCanvasGitProviderLabel } from "@/components/ppm-git/git-provider-labels";
import { PpmCanvasMapService } from "@/services/ppm-canvas-map.service";
import { PpmCanvasService } from "@/services/ppm-canvas.service";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const BOARD = "33333333-3333-4333-8333-333333333333";
const PR = "44444444-4444-4444-8444-444444444444";
const COMMIT = "55555555-5555-4555-8555-555555555555";
const WORK_ITEM = "66666666-6666-4666-8666-666666666666";

function gitBinding(provider: string, entityId: string, objectType: "pull_request" | "commit", shapeId: string) {
  return {
    binding_id: entityId.replace(/^4|^5/, "7"),
    binding_status: "pending",
    shape_id: shapeId,
    entity_type: objectType,
    entity_id: entityId,
    source_version: `${objectType}:v1`,
    source: {
      identity: {
        entity_type: objectType,
        entity_id: entityId,
        workspace_id: WS,
        project_id: PROJECT,
        source_url:
          provider === "forgejo"
            ? "https://git.ppm.example/lab/robot/pulls/7"
            : "https://github.com/lab/site/commit/abc",
      },
      display: {
        title: "ROBOT-7: захват",
        provider,
        repository_name: provider === "forgejo" ? "lab/robot" : "lab/site",
        object_type: objectType,
        ref: "7",
        state: "open",
        author_name: "Анна",
        base_ref: "main",
        head_ref: "robot-7/gripper",
        commit_sha: "a".repeat(40),
        work_items: [{ id: WORK_ITEM, identifier: "ROBOT-7", title: "Захват" }],
        source_status: "active",
      },
      capabilities: { read: true, update: false, delete_source: false },
      source_version: `${objectType}:v1`,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("«На холст» for our Git server", () => {
  it("puts a Forgejo pull request on the board (bindGit)", async () => {
    const service = new PpmCanvasService();
    vi.spyOn(service, "post").mockResolvedValue({
      data: { ...gitBinding("forgejo", PR, "pull_request", "shape:pr"), idempotent_replay: false },
    } as never);

    const binding = await service.bindGit(WS, PROJECT, BOARD, {
      shape_id: "shape:pr",
      entity_type: "pull_request",
      entity_id: PR,
      client_operation_id: "op-1",
    });
    expect(binding.source.display.provider).toBe("forgejo");
  });

  it("refreshes a board that holds a Forgejo card (getBindings)", async () => {
    const service = new PpmCanvasService();
    vi.spyOn(service, "get").mockResolvedValue({
      data: {
        board_id: BOARD,
        bindings: [
          gitBinding("forgejo", PR, "pull_request", "shape:pr"),
          gitBinding("github", COMMIT, "commit", "shape:c"),
        ],
        work_item_options: { states: [], priorities: ["none"], assignees: [] },
      },
    } as never);

    const response = await service.getBindings(WS, PROJECT, BOARD);
    expect(
      response.bindings.map((item) => "work_items" in item.source.display && item.source.display.provider)
    ).toEqual(["forgejo", "github"]);
  });

  it("binds a «Не на карте» pack with a Forgejo PR next to a GitHub commit (bindBatch)", async () => {
    const service = new PpmCanvasMapService();
    const items = [
      { entity_id: PR, entity_type: "pull_request" as const, shape_id: "shape:pr" },
      { entity_id: COMMIT, entity_type: "commit" as const, shape_id: "shape:c" },
    ];
    vi.spyOn(service, "post").mockResolvedValue({
      data: {
        results: [
          {
            binding: { ...gitBinding("forgejo", PR, "pull_request", "shape:pr"), idempotent_replay: false },
            shape_id: "shape:pr",
            status: "created",
          },
          {
            binding: { ...gitBinding("github", COMMIT, "commit", "shape:c"), idempotent_replay: false },
            shape_id: "shape:c",
            status: "created",
          },
        ],
      },
    } as never);

    expect((await service.bindBatch(WS, PROJECT, BOARD, items)).map((result) => result.status)).toEqual([
      "created",
      "created",
    ]);
  });
});

describe("the provider on the canvas Git card", () => {
  it("names our Git server in the UI language", () => {
    expect(getCanvasGitProviderLabel("forgejo", "ru")).toBe("Наш Git-сервер");
    expect(getCanvasGitProviderLabel("forgejo", "ru-RU")).toBe("Наш Git-сервер");
    expect(getCanvasGitProviderLabel("forgejo", "en")).toBe("Our Git server");
    expect(getCanvasGitProviderLabel("forgejo", undefined)).toBe("Our Git server");
  });

  it("keeps the RC.1 label of every other provider", () => {
    expect(getCanvasGitProviderLabel("github", "ru")).toBe("GITHUB");
    expect(getCanvasGitProviderLabel("github", "en")).toBe("GITHUB");
    expect(getCanvasGitProviderLabel("gitlab", "ru")).toBe("GITLAB");
    expect(getCanvasGitProviderLabel("generic", "ru")).toBe("GENERIC");
  });

  it("is what the Git card shows next to the repository", () => {
    const shape = readFileSync(new URL("../../core/components/ppm-canvas/shape.tsx", import.meta.url), "utf8");
    expect(shape).toContain('{getCanvasGitProviderLabel(display?.provider ?? node.provider, currentLocale)} ·{" "}');
    expect(shape).not.toContain("(display?.provider ?? node.provider).toUpperCase()");
  });
});
