// G1.3 (RC-C): the «Код» page shows each Git write step with honest Russian labels, only offers buttons to people
// who may decide, and explains the manual path while the administrator keeps GitHub writes switched off.
import { describe, expect, it } from "vitest";
import {
  buildManualBranchCommands,
  buildManualPullRequestUrl,
  getGitWriteActionView,
  isSafeGitRefName,
  isSafeSha,
} from "@/helpers/ppm-git-write-flow.helper";
import type { TPpmGitWriteAction } from "@/services/ppm-git.service";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function action(overrides: Partial<TPpmGitWriteAction> = {}): TPpmGitWriteAction {
  const stage = overrides.stage ?? "branch";
  return {
    id: "action-1",
    action_type:
      stage === "pull_request" ? "create_draft_pr" : stage === "legacy" ? "create_branch_draft_pr" : "create_branch",
    stage,
    status: "proposed",
    client_operation_id: "op-1",
    parent_action_id: stage === "pull_request" ? "branch-1" : null,
    base_sha: BASE_SHA,
    head_sha: stage === "pull_request" ? HEAD_SHA : "",
    preview: {
      stage: stage === "legacy" ? undefined : stage,
      repository: {
        id: "repo-1",
        provider: "github",
        name: "robot",
        full_name: "ppm-org/robot",
        canonical_url: "https://github.com/ppm-org/robot",
      },
      provider: { connection_id: "c-1", account_login: "ppm-org", permissions: {}, write_ready: false },
      branch: { base_ref: "main", base_sha: BASE_SHA, head_ref: "robot-7/gripper" },
      draft_pull_request: { title: "ROBOT-7 — Захват", body: "", is_draft: true },
      work_item: { id: "wi-1", identifier: "ROBOT-7", title: "Захват", updated_at: "2026-09-27T00:00:00Z" },
      safety: { provider_write_performed: false, merge_allowed: false, message: "Предпросмотр" },
    },
    result: {},
    error: null,
    created_by: "u-1",
    decided_by: null,
    applied_by: null,
    cancelled_by: null,
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    decided_at: null,
    applied_at: null,
    cancelled_at: null,
    apply_attempts: 0,
    retry_after: null,
    apply_available: false,
    apply_blockers: ["APPROVAL_REQUIRED"],
    can_cancel: true,
    outcome_unknown: false,
    follow_up: null,
    ...overrides,
  };
}

describe("Git write step view", () => {
  it("asks a manager to approve or reject a proposed branch", () => {
    const view = getGitWriteActionView(action(), { canManage: true });
    expect(view.stageLabel).toBe("Шаг 1 · ветка");
    expect(view.statusLabel).toBe("Ждёт подтверждения");
    expect(view.commands).toEqual(["reject", "approve"]);
  });

  it("offers no buttons to people who may only read", () => {
    for (const status of ["proposed", "approved", "failed", "applied"] as const) {
      const view = getGitWriteActionView(action({ status }), { canManage: false });
      expect(view.commands, status).toEqual([]);
    }
    expect(getGitWriteActionView(action(), { canManage: false }).notice).toContain("руководитель и участники");
  });

  it("keeps apply visible but disabled and explains the manual path while writes are off", () => {
    const view = getGitWriteActionView(action({ status: "approved", apply_blockers: ["PROVIDER_WRITE_DISABLED"] }), {
      canManage: true,
    });
    expect(view.commands).toEqual(["cancel", "apply"]);
    expect(view.applyLabel).toBe("Создать ветку в GitHub");
    expect(view.applyDisabledReason).toContain("выключена администратором");
    expect(view.manual).toEqual({
      kind: "branch",
      commands: ["git fetch origin", `git switch -c robot-7/gripper ${BASE_SHA}`, "git push -u origin robot-7/gripper"],
    });
  });

  it("enables apply once writes and permissions are ready", () => {
    const view = getGitWriteActionView(action({ status: "approved", apply_available: true, apply_blockers: [] }), {
      canManage: true,
    });
    expect(view.applyDisabledReason).toBeUndefined();
    expect(view.manual).toBeUndefined();
  });

  it("names missing GitHub permissions instead of a generic failure", () => {
    const view = getGitWriteActionView(action({ status: "approved", apply_blockers: ["GITHUB_PERMISSIONS_MISSING"] }), {
      canManage: true,
    });
    expect(view.applyDisabledReason).toContain("Проверить права");
  });

  it("links the manual draft PR to GitHub's compare page for the exact branches", () => {
    const pr = action({ stage: "pull_request", status: "approved", apply_blockers: ["PROVIDER_WRITE_DISABLED"] });
    const view = getGitWriteActionView(pr, { canManage: true });
    expect(view.stageLabel).toBe("Шаг 2 · черновик PR");
    expect(view.applyLabel).toBe("Создать черновик PR в GitHub");
    expect(view.manual).toEqual({
      kind: "pull_request",
      url: "https://github.com/ppm-org/robot/compare/main...robot-7/gripper?expand=1",
    });
  });

  it("guides from a created branch to the second step and marks commits seen by the webhook", () => {
    const waiting = action({
      status: "applied",
      apply_blockers: ["STATUS_FINAL"],
      can_cancel: false,
      result: {
        branch: { ref: "robot-7/gripper", sha: BASE_SHA, canonical_url: "https://github.com/x/tree/b", created: true },
      },
      follow_up: {
        pull_request_ready: false,
        branch_head_sha: BASE_SHA,
        branch_active: true,
        pull_request_action: null,
      },
    });
    const waitingView = getGitWriteActionView(waiting, { canManage: true });
    expect(waitingView.statusLabel).toBe("Ветка создана");
    expect(waitingView.tone).toBe("success");
    expect(waitingView.resultUrl).toBe("https://github.com/x/tree/b");
    expect(waitingView.commands).toEqual(["prepare_pull_request"]);
    expect(waitingView.notice).toContain("commit и push");

    const ready = getGitWriteActionView(
      { ...waiting, follow_up: { ...waiting.follow_up!, pull_request_ready: true, branch_head_sha: HEAD_SHA } },
      { canManage: true }
    );
    expect(ready.notice).toContain("новые коммиты");

    const started = getGitWriteActionView(
      { ...waiting, follow_up: { ...waiting.follow_up!, pull_request_action: { id: "pr-1", status: "proposed" } } },
      { canManage: true }
    );
    expect(started.commands).toEqual(["open_follow_up"]);
  });

  it("never offers merge after the draft PR exists", () => {
    const view = getGitWriteActionView(
      action({
        stage: "pull_request",
        status: "applied",
        apply_blockers: ["STATUS_FINAL"],
        can_cancel: false,
        result: {
          pull_request: {
            provider_object_id: "1",
            number: "7",
            canonical_url: "https://github.com/ppm-org/robot/pull/7",
            is_draft: true,
            state: "open",
            base_ref: "main",
            head_ref: "robot-7/gripper",
            head_sha: HEAD_SHA,
            created: true,
          },
        },
      }),
      { canManage: true }
    );
    expect(view.statusLabel).toBe("Черновик PR создан");
    expect(view.commands).toEqual([]);
    expect(view.notice).toContain("только в GitHub");
  });

  it("offers an explicit retry after a failure and holds it until GitHub's wait time", () => {
    const failed = action({
      status: "failed",
      error: { code: "GITHUB_RATE_LIMITED", message: "GitHub временно ограничил частоту." },
      retry_after: "2026-09-27T10:45:00Z",
      apply_blockers: ["RETRY_LATER"],
    });
    const view = getGitWriteActionView(failed, { canManage: true });
    expect(view.tone).toBe("danger");
    expect(view.commands).toEqual(["cancel", "retry"]);
    expect(view.applyLabel).toBe("Повторить");
    expect(view.applyDisabledReason).toContain("подождать");
    expect(
      getGitWriteActionView({ ...failed, apply_available: true, apply_blockers: [] }, { canManage: true })
    ).toMatchObject({ applyDisabledReason: undefined });
  });

  it("sends a stale preview back to a new preview", () => {
    const view = getGitWriteActionView(
      action({
        status: "conflict",
        apply_blockers: ["STATUS_FINAL"],
        can_cancel: false,
        error: { code: "GITHUB_BASE_MOVED", message: "Базовая ветка изменилась." },
      }),
      { canManage: true }
    );
    expect(view.statusLabel).toBe("Нужен новый предпросмотр");
    expect(view.commands).toEqual(["prepare_again"]);
    expect(view.notice).toContain("Базовая ветка изменилась.");
  });

  it("explains legacy single-step proposals", () => {
    const view = getGitWriteActionView(
      action({ stage: "legacy", status: "cancelled", apply_blockers: ["LEGACY_FLOW"], can_cancel: false }),
      { canManage: true }
    );
    expect(view.stageLabel).toBe("Старое предложение");
    expect(view.notice).toContain("подтверждаются отдельно");
    expect(view.commands).toEqual(["prepare_again"]);
  });
});

describe("manual Git fallback", () => {
  it("accepts only shell-neutral branch names and plain hex SHAs", () => {
    expect(isSafeGitRefName("robot-7/gripper")).toBe(true);
    expect(isSafeGitRefName("Release_1.2/fix-3")).toBe(true);
    // Payloads from the review: PowerShell (`'` is not escaped by `\`), cmd (`&`), POSIX `$(…)`.
    for (const name of [
      "x';calc;#",
      "x&calc&",
      "gwa-1/$(id)",
      "a|b",
      "a`b",
      'a"b',
      "a b",
      "a+b",
      "a@b",
      "-a",
      "a/",
      "a..b",
      "a//b",
      "a.lock",
      ".a",
      "a/.b",
      "a".repeat(245),
    ]) {
      expect(isSafeGitRefName(name), name).toBe(false);
    }
    expect(isSafeSha(BASE_SHA)).toBe(true);
    for (const sha of ["", "$(id)", "A".repeat(40), "a".repeat(39), `${BASE_SHA};calc`]) {
      expect(isSafeSha(sha), sha).toBe(false);
    }
  });

  it("never offers copyable commands for a name a shell could interpret — only a GitHub link and a hint", () => {
    for (const head of ["x';calc;#", "x&calc&", "gwa-1/$(id)"]) {
      const risky = action({
        status: "approved",
        apply_blockers: ["PROVIDER_WRITE_DISABLED"],
        preview: { ...action().preview, branch: { base_ref: "main", base_sha: BASE_SHA, head_ref: head } },
      });
      expect(buildManualBranchCommands(risky), head).toBeUndefined();
      const view = getGitWriteActionView(risky, { canManage: true });
      expect(view.manual, head).toEqual({
        kind: "branch_link",
        url: "https://github.com/ppm-org/robot/branches",
        baseRef: "main",
        baseSha: BASE_SHA,
      });
      expect(JSON.stringify(view)).not.toContain("calc");
    }
  });

  it("does not put an unexpected SHA into a command either", () => {
    const odd = action({ base_sha: "$(id)", status: "approved", apply_blockers: ["PROVIDER_WRITE_DISABLED"] });
    expect(buildManualBranchCommands(odd)).toBeUndefined();
    expect(getGitWriteActionView(odd, { canManage: true }).manual?.kind).toBe("branch_link");
  });

  it("encodes compare URLs but keeps branch path separators", () => {
    const pr = action({
      stage: "pull_request",
      preview: { ...action().preview, branch: { base_ref: "main", head_ref: "a b/c#d" } },
    });
    expect(buildManualPullRequestUrl(pr)).toBe("https://github.com/ppm-org/robot/compare/main...a%20b/c%23d?expand=1");
  });

  it("links results only to GitHub", () => {
    const applied = action({
      status: "applied",
      apply_blockers: ["STATUS_FINAL"],
      can_cancel: false,
      result: { branch: { ref: "x", sha: BASE_SHA, canonical_url: "javascript:alert(1)", created: true } },
      follow_up: {
        pull_request_ready: false,
        branch_head_sha: BASE_SHA,
        branch_active: true,
        pull_request_action: null,
      },
    });
    expect(getGitWriteActionView(applied, { canManage: true }).resultUrl).toBeUndefined();
  });
});

describe("unconfirmed outcome", () => {
  it("links to GitHub to check a step whose result could not be confirmed", () => {
    const view = getGitWriteActionView(
      action({
        stage: "pull_request",
        status: "conflict",
        apply_blockers: ["STATUS_FINAL"],
        can_cancel: false,
        outcome_unknown: true,
        error: {
          code: "GITHUB_PULL_REQUEST_UNCONFIRMED",
          message: "Не удалось подтвердить, создан ли PR — проверьте в GitHub.",
        },
        result: {
          outcome_unknown: true,
          error_details: {
            canonical_url: "https://github.com/ppm-org/robot/pulls?q=is%3Apr%20head%3Arobot-7%2Fgripper",
          },
        },
      }),
      { canManage: true }
    );
    expect(view.notice).toContain("Не удалось подтвердить, создан ли PR — проверьте в GitHub.");
    expect(view.checkUrl).toBe("https://github.com/ppm-org/robot/pulls?q=is%3Apr%20head%3Arobot-7%2Fgripper");
    expect(view.commands).toEqual(["prepare_again"]);
    const hostile = getGitWriteActionView(
      action({ status: "failed", result: { error_details: { canonical_url: "javascript:alert(1)" } } }),
      { canManage: true }
    );
    expect(hostile.checkUrl).toBeUndefined();
  });
});

describe("interrupted apply", () => {
  it("offers only «Повторить» while GitHub may already hold the object", () => {
    const stale = action({ status: "applying", apply_blockers: [], can_cancel: false, outcome_unknown: true });
    expect(getGitWriteActionView(stale, { canManage: true }).commands).toEqual(["retry"]);

    const unknown = getGitWriteActionView(
      action({
        status: "failed",
        error: { code: "GITHUB_UNAVAILABLE", message: "GitHub временно недоступен." },
        apply_available: true,
        apply_blockers: [],
        can_cancel: false,
        outcome_unknown: true,
      }),
      { canManage: true }
    );
    expect(unknown.commands).toEqual(["retry"]);
    expect(unknown.notice).toContain("Неизвестно");
    expect(unknown.notice).toContain("Повторить");
  });
});
