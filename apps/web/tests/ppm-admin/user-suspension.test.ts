// G2.2 R15a: «Отключить» / «Включить» a person in the admin center's «Пользователи» tab. The API decides who may be
// switched off (`can_suspend` / `can_resume` — never oneself, a PPM global administrator, an instance administrator,
// a service account or a person who deactivated their own account); the row shows exactly the action it allows and
// asks first («Отключить <имя>? Он не сможет войти в PPM и на Git-сервер»). Rows are checked through the pure
// helper; the wiring of `admin-center.tsx` (hooks throughout) by source, as git-server-panel-wiring.test.ts does.
import { readFileSync } from "node:fs";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import {
  getUserAction,
  getUserActionConfirm,
  getUserName,
  getUserStatus,
  USER_STATUS_LABEL_KEYS,
} from "@/components/ppm-admin/user-suspension.helper";
import { ppmAdminUserSchema, PpmAdminService, PpmAdminServiceError } from "@/services/ppm-admin.service";

const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);

// A row as the API answered before G2.2 R15a, and as it answers now.
const olderRow = {
  user_id: "33333333-3333-4333-8333-333333333333",
  display_name: "Иван Петров",
  email: "ivan@ppm.local",
  avatar_url: null,
  is_active: true,
  is_bot: false,
  is_global_admin: false,
  workspace_count: 1,
  project_count: 2,
  last_active: null,
};
const row = { ...olderRow, is_suspended: false, suspended_at: null, can_suspend: true, can_resume: false };

function httpError(status: number, data: unknown) {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError(
    "Request failed",
    "ERR_BAD_RESPONSE",
    config,
    {},
    { status, statusText: "", headers, config, data }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a person's state in the users list", () => {
  it("tells a switched-off person from one who deactivated their own account", () => {
    expect(getUserStatus({ is_active: true, is_suspended: false })).toBe("active");
    expect(getUserStatus({ is_active: false, is_suspended: true })).toBe("suspended");
    expect(getUserStatus({ is_active: false, is_suspended: false })).toBe("deactivated");
    expect(ru(USER_STATUS_LABEL_KEYS.active)).toBe("Активен");
    expect(ru(USER_STATUS_LABEL_KEYS.suspended)).toBe("Отключён");
    expect(ru(USER_STATUS_LABEL_KEYS.deactivated)).toBe("Аккаунт деактивирован");
  });

  it("offers exactly the action the API allows — nothing for protected people", () => {
    expect(getUserAction({ can_suspend: true, can_resume: false })).toBe("suspend");
    expect(getUserAction({ can_suspend: false, can_resume: true })).toBe("resume");
    expect(getUserAction({ can_suspend: false, can_resume: false })).toBeNull();
  });

  it("asks before switching a person off, in the spec's words, and before switching back on", () => {
    const suspend = getUserActionConfirm("suspend", getUserName(row), ru, true);
    expect(suspend.title).toBe("Отключить Иван Петров?");
    expect(String(suspend.content)).toMatch(/^Он не сможет войти в PPM и на Git-сервер/);
    expect(suspend.confirmLabel).toBe("Отключить");
    expect(suspend.variant).toBe("danger");

    const resume = getUserActionConfirm("resume", getUserName(row), ru, true);
    expect(resume.title).toBe("Включить Иван Петров?");
    expect(String(resume.content)).toContain("Git-сервер");
    expect(resume.confirmLabel).toBe("Включить");
    expect(resume.variant).toBe("primary");
  });

  it("names the Git server only while single sign-on is on there (review round 1)", () => {
    const suspend = getUserActionConfirm("suspend", getUserName(row), ru, false);
    expect(String(suspend.content)).toMatch(/^Он не сможет войти в PPM, открытые сеансы завершатся/);
    expect(String(suspend.content)).not.toContain("Git");
    expect(String(getUserActionConfirm("resume", getUserName(row), ru, false).content)).not.toContain("Git");
  });

  it("keeps a name with replacement patterns literal (review round 1)", () => {
    for (const name of ["$& и $1", "$$ Петров", "$`Иван$'"])
      expect(getUserActionConfirm("suspend", name, ru, true).title).toBe(`Отключить ${name}?`);
  });

  it("names a person without a display name by e-mail", () => {
    expect(getUserName({ display_name: "", email: "anna@ppm.local" })).toBe("anna@ppm.local");
    expect(getUserName({ display_name: "", email: null })).toBe("—");
  });
});

describe("PpmAdminService — «Отключить» / «Включить»", () => {
  it("posts to the exact endpoints and returns the updated row", async () => {
    const service = new PpmAdminService();
    const switchedOff = {
      ...row,
      is_active: false,
      is_suspended: true,
      suspended_at: "2026-09-29T07:00:00+03:00",
      can_suspend: false,
      can_resume: true,
    };
    const post = vi
      .spyOn(service, "post")
      .mockResolvedValueOnce({ data: switchedOff } as never)
      .mockResolvedValueOnce({ data: row } as never);

    await expect(service.suspendUser(row.user_id)).resolves.toMatchObject({ is_suspended: true, can_resume: true });
    await expect(service.resumeUser(row.user_id)).resolves.toMatchObject({ is_active: true, can_suspend: true });
    expect(post.mock.calls).toEqual([
      [`/api/ppm/v1/admin/users/${row.user_id}/suspend/`],
      [`/api/ppm/v1/admin/users/${row.user_id}/resume/`],
    ]);
  });

  it("surfaces the API's Russian refusal (a protected person) with its code", async () => {
    const service = new PpmAdminService();
    vi.spyOn(service, "post").mockRejectedValue(
      httpError(403, {
        error: {
          code: "ADMIN_USER_PROTECTED",
          message: "Главного администратора PPM отключить нельзя.",
          details: { reason: "global_admin" },
        },
      })
    );

    const error = (await service.suspendUser(row.user_id).catch((reason: unknown) => reason)) as PpmAdminServiceError;
    expect(error).toBeInstanceOf(PpmAdminServiceError);
    expect(error.code).toBe("ADMIN_USER_PROTECTED");
    expect(error.status).toBe(403);
    expect(error.message).toBe("Главного администратора PPM отключить нельзя.");
  });

  it("reads a row without the switch-off fields as «no action» rather than failing the list", () => {
    expect(ppmAdminUserSchema.parse(olderRow)).toMatchObject({
      is_suspended: false,
      suspended_at: null,
      can_suspend: false,
      can_resume: false,
    });
  });
});

describe("admin-center.tsx wires the users list to the actions", () => {
  const adminCenter = readFileSync(
    new URL("../../core/components/ppm-admin/admin-center.tsx", import.meta.url),
    "utf8"
  );
  const userRow = adminCenter.slice(
    adminCenter.indexOf("function UserRow("),
    adminCenter.indexOf("function UsersPanel(")
  );
  const usersPanel = adminCenter.slice(
    adminCenter.indexOf("function UsersPanel("),
    adminCenter.indexOf("function AuditRow(")
  );

  it("shows a button only for the action the row allows, and asks before calling the API", () => {
    expect(userRow).toContain("const action = getUserAction(user);");
    expect(userRow).toMatch(/\{action && \(\s*<Button/);
    const asked = userRow.indexOf("await confirm(getUserActionConfirm(action, getUserName(user), ppmT, gitServerSso))");
    const called = userRow.indexOf("adminService.suspendUser(user.user_id)");
    expect(asked).toBeGreaterThan(-1);
    expect(called).toBeGreaterThan(asked);
    expect(userRow).toContain("adminService.resumeUser(user.user_id)");
  });

  it("refreshes the list after an action and shows a refusal in the row", () => {
    expect(userRow).toContain("await onChanged();");
    expect(usersPanel).toContain("onChanged={() => mutate()}");
    // The API's own Russian refusal for 4xx, the action's text for a server or network failure.
    expect(userRow).toContain("error instanceof PpmAdminServiceError && (error.status ?? 500) < 500 ? error.message");
    expect(userRow).toContain('ppmT(action === "suspend" ? "g22.users.suspend_error" : "g22.users.resume_error")');
    // A conflict (someone else acted) or a vanished person reloads the list to its real state.
    expect(userRow).toContain("(error.status === 404 || error.status === 409)) void onChanged();");
  });

  it("renders one confirmation dialog for the whole list (usePpmConfirm)", () => {
    expect(usersPanel).toContain("const { confirm, confirmDialog } = usePpmConfirm();");
    expect(usersPanel).toContain("{confirmDialog}");
  });

  it("takes «single sign-on is on» from the «Git-сервер» tab's status, shared by key, and passes it to the rows", () => {
    expect(usersPanel).toContain('useSWR("ppm-admin-git-server-status", () => adminService.getGitServerStatus(), {');
    expect(usersPanel).toContain("const gitServerSso = gitServer?.sso_enabled === true;");
    expect(usersPanel).toContain("gitServerSso={gitServerSso}");
    const panel = readFileSync(
      new URL("../../core/components/ppm-admin/git-server-panel.tsx", import.meta.url),
      "utf8"
    );
    expect(panel).toContain('useSWR("ppm-admin-git-server-status", () =>');
  });

  it("labels the state through the helper, with the time of switching off", () => {
    expect(userRow).toContain("ppmT(USER_STATUS_LABEL_KEYS[status])");
    expect(userRow).toContain('ppmT("g22.users.suspended_since").replace("{date}", formatDate(user.suspended_at))');
  });
});
