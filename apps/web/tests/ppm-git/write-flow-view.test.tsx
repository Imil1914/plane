// G1.3 (RC-C): rendered «Код» write-flow blocks — buttons only for people with the right, the disabled apply button
// explains itself, and the manual path is shown while GitHub writes are switched off.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitWriteActionDetails, GitWriteActionsPanel } from "@/components/ppm-git/git-write-flow";
import type { TPpmGitWriteAction, TPpmGitWriteReadiness } from "@/services/ppm-git.service";

const BASE_SHA = "c".repeat(40);

const approvedBranch: TPpmGitWriteAction = {
  id: "a-1",
  action_type: "create_branch",
  stage: "branch",
  status: "approved",
  client_operation_id: "op-1",
  parent_action_id: null,
  base_sha: BASE_SHA,
  head_sha: "",
  preview: {
    stage: "branch",
    repository: {
      id: "r-1",
      provider: "github",
      name: "robot",
      full_name: "ppm-org/robot",
      canonical_url: "https://github.com/ppm-org/robot",
    },
    provider: { connection_id: "c-1", account_login: "ppm-org", permissions: {}, write_ready: false },
    branch: { base_ref: "main", base_sha: BASE_SHA, head_ref: "robot-7/gripper" },
    draft_pull_request: { title: "ROBOT-7 — Захват", body: "", is_draft: true, planned: true },
    work_item: { id: "w-1", identifier: "ROBOT-7", title: "Захват", updated_at: "2026-09-27T00:00:00Z" },
    safety: { provider_write_performed: false, merge_allowed: false, message: "Это предварительный просмотр." },
  },
  result: {},
  error: null,
  created_by: "u-1",
  decided_by: "u-1",
  applied_by: null,
  cancelled_by: null,
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
  decided_at: "2026-09-27T00:00:00Z",
  applied_at: null,
  cancelled_at: null,
  apply_attempts: 0,
  retry_after: null,
  apply_available: false,
  apply_blockers: ["PROVIDER_WRITE_DISABLED"],
  can_cancel: true,
  outcome_unknown: false,
  follow_up: null,
};

const readiness: TPpmGitWriteReadiness = {
  provider: "github",
  flow: "branch_then_commit_then_draft_pr",
  decision_status: "accepted",
  required_permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  provider_writes_enabled: false,
  permission_ready: true,
  apply_available: false,
  blockers: ["PROVIDER_WRITE_DISABLED"],
  connections: [],
};

const noop = () => undefined;

describe("Git write flow on the «Код» page", () => {
  it("shows a disabled apply with its reason and copyable manual commands while writes are off", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionDetails
        action={approvedBranch}
        canManage
        saving={false}
        onCommand={noop}
        onCopy={noop}
        onRefresh={noop}
      />
    );
    expect(html).toContain("Создать ветку в GitHub");
    expect(html).toMatch(/<button[^>]*aria-describedby="git-write-apply-reason-a-1"[^>]*disabled=""/);
    expect(html).toContain("выключена администратором");
    expect(html).toContain("Как создать ветку вручную");
    expect(html).toContain(`git switch -c robot-7/gripper ${BASE_SHA}`);
    expect(html).toContain("Скопировать команды");
    expect(html).not.toMatch(/merge<\/button>|Слить/);
  });

  it("gives no copyable command for a branch name a shell could interpret", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionDetails
        action={{
          ...approvedBranch,
          preview: {
            ...approvedBranch.preview,
            branch: { base_ref: "main", base_sha: BASE_SHA, head_ref: "x';calc;#" },
          },
        }}
        canManage
        saving={false}
        onCommand={noop}
        onCopy={noop}
        onRefresh={noop}
      />
    );
    expect(html).not.toContain("git switch");
    expect(html).not.toContain("Скопировать команды");
    expect(html).toContain("нельзя безопасно вставить в терминал");
    expect(html).toContain('href="https://github.com/ppm-org/robot/branches"');
  });

  it("offers only «Повторить» after an interrupted apply", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionDetails
        action={{
          ...approvedBranch,
          status: "failed",
          error: { code: "GITHUB_UNAVAILABLE", message: "GitHub временно недоступен." },
          apply_available: true,
          apply_blockers: [],
          can_cancel: false,
          outcome_unknown: true,
        }}
        canManage
        saving={false}
        onCommand={noop}
        onCopy={noop}
        onRefresh={noop}
      />
    );
    expect(html).toContain(">Повторить</button>");
    expect(html).not.toContain(">Отменить</button>");
    expect(html).toContain("отменить до этой проверки нельзя");
  });

  it("shows the hidden PR marker in the draft PR preview", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionDetails
        action={{
          ...approvedBranch,
          action_type: "create_draft_pr",
          stage: "pull_request",
          parent_action_id: "a-0",
          head_sha: "d".repeat(40),
          preview: {
            ...approvedBranch.preview,
            stage: "pull_request",
            branch: { base_ref: "main", base_sha: BASE_SHA, head_ref: "robot-7/gripper", head_sha: "d".repeat(40) },
            commits: { ahead_by: 1, truncated: false, items: [] },
            draft_pull_request: {
              title: "ROBOT-7 — Захват",
              body: "Описание",
              is_draft: true,
              marker: "<!-- ppm-write-action:a-1 -->",
            },
          },
        }}
        canManage
        saving={false}
        onCommand={noop}
        onCopy={noop}
        onRefresh={noop}
      />
    );
    expect(html).toContain("&lt;!-- ppm-write-action:a-1 --&gt;");
    expect(html).toContain("узнаёт только свой PR");
  });

  it("renders no decision buttons for a reader", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionDetails
        action={{ ...approvedBranch, status: "proposed", apply_blockers: ["APPROVAL_REQUIRED"] }}
        canManage={false}
        saving={false}
        onCommand={noop}
        onCopy={noop}
        onRefresh={noop}
      />
    );
    expect(html).not.toContain("Подтвердить создание ветки");
    expect(html).not.toContain("Отклонить");
    expect(html).toContain("руководитель и участники проекта");
  });

  it("explains the switched-off write and hides «new branch» from people who cannot prepare it", () => {
    const html = renderToStaticMarkup(
      <GitWriteActionsPanel
        actions={[approvedBranch]}
        canPrepare={false}
        canRefreshPermissions={false}
        readiness={readiness}
        refreshingPermissions={false}
        onOpen={noop}
        onPrepare={noop}
        onRefreshPermissions={noop}
      />
    );
    expect(html).toContain("Запись в GitHub выключена администратором PPM");
    expect(html).not.toContain("Новая ветка для задачи");
    expect(html).toContain("Ветка robot-7/gripper");
    expect(html).toContain("Подтверждено");
  });
});
