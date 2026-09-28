// G2.1: objects of our Git server (`forgejo`) go on the canvas like GitHub ones — the live projection
// (bindGit, the «Не на карте» batch, the board refresh) and the stored `git_ref` node parse; GitHub parses as before.
import { describe, expect, it } from "vitest";
import {
  createPpmGitRefNode,
  parseAndMigratePpmCanvasNode,
  PPM_CANVAS_GIT_PROVIDERS,
  ppmCanvasBindingMutationResponseSchema,
  ppmCanvasBindingSchema,
  ppmCanvasGitProjectionSchema,
} from "../index";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";
const BINDING = "44444444-4444-4444-8444-444444444444";
const WORK_ITEM = "55555555-5555-4555-8555-555555555555";

function projection(provider: string, sourceUrl: string) {
  return {
    identity: {
      entity_type: "pull_request",
      entity_id: OBJECT,
      workspace_id: WORKSPACE,
      project_id: PROJECT,
      source_url: sourceUrl,
    },
    display: {
      title: "ROBOT-7: захват",
      provider,
      repository_name: "lab/robot",
      object_type: "pull_request",
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
    source_version: "pr-7:v1",
  };
}

function binding(provider: string, sourceUrl: string) {
  return {
    binding_id: BINDING,
    binding_status: "pending",
    shape_id: "shape:robot-pr",
    entity_type: "pull_request",
    entity_id: OBJECT,
    source_version: "pr-7:v1",
    source: projection(provider, sourceUrl),
  };
}

const FORGEJO_PR = "https://git.ppm.example/lab/robot/pulls/7";
const GITHUB_PR = "https://github.com/lab/robot/pull/7";

describe("Git providers on the canvas", () => {
  it("knows our Git server next to the RC.1 providers", () => {
    expect(PPM_CANVAS_GIT_PROVIDERS).toEqual(["github", "forgejo", "gitlab", "bitbucket", "gitea", "generic"]);
  });

  it("parses a live projection of our Git server (bindGit, the board refresh, the «Не на карте» batch)", () => {
    expect(ppmCanvasGitProjectionSchema.parse(projection("forgejo", FORGEJO_PR)).display.provider).toBe("forgejo");
    expect(ppmCanvasBindingSchema.parse(binding("forgejo", FORGEJO_PR))).toMatchObject({
      entity_type: "pull_request",
      source: { display: { provider: "forgejo" } },
    });
    expect(
      ppmCanvasBindingMutationResponseSchema.parse({ ...binding("forgejo", FORGEJO_PR), idempotent_replay: false })
    ).toMatchObject({ source: { display: { provider: "forgejo" } } });
  });

  it("stores a Git card of our Git server as a valid git_ref node", () => {
    const node = createPpmGitRefNode({
      authorId: "user-1",
      binding: { binding_id: BINDING, entity_type: "pull_request", entity_id: OBJECT, source_version: "pr-7:v1" },
      canonicalUrl: FORGEJO_PR,
      now: "2026-09-28T10:00:00.000Z",
      objectType: "pull_request",
      provider: "forgejo",
      repositoryName: "lab/robot",
      sourceId: OBJECT,
      title: "ROBOT-7: захват",
      workItemKey: "ROBOT-7",
    });
    expect(node.provider).toBe("forgejo");
    expect(parseAndMigratePpmCanvasNode(node)).toEqual({ status: "valid", node });
  });

  it("parses GitHub exactly as before", () => {
    const github = binding("github", GITHUB_PR);
    expect(ppmCanvasBindingSchema.parse(github)).toEqual(github);
    expect(ppmCanvasGitProjectionSchema.parse(github.source)).toEqual(github.source);
  });

  it("reads a GitHub card of an old board unchanged", () => {
    // A git_ref node as RC.1 stored it in a board document (schema 2 since 2026-09-24).
    const stored = {
      schema_version: 2,
      kind: "git_ref",
      source_id: OBJECT,
      title: "GIT-1 — Git integration",
      provider: "github",
      repository_name: "PPM",
      object_type: "pull_request",
      canonical_url: GITHUB_PR,
      work_item_key: "GIT-1",
      binding: { binding_id: BINDING, entity_type: "pull_request", entity_id: OBJECT, source_version: "pr-7:v1" },
      author_id: "user-1",
      created_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-20T10:00:00.000Z",
      visual: { color: "violet", width: 360, height: 220 },
    };
    expect(parseAndMigratePpmCanvasNode(stored)).toEqual({ status: "valid", node: stored });
  });

  it("still refuses an unknown provider", () => {
    expect(ppmCanvasGitProjectionSchema.safeParse(projection("gitlab-ee", FORGEJO_PR)).success).toBe(false);
  });
});
