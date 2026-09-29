// G2.3 (G-Web): the two dialogs' error-banner text. Review round 2 (#1): `getWorkSummaryErrorMessage` must show the
// API's own `message` for `WORK_SUMMARY_RANGE_INVALID` — that one code covers several distinct reasons server-side
// (too long, malformed date, "from" after "to", a calendar overflow like 30 February…), each with its own precise
// Russian sentence (`apps/api/plane/ppm_git/work_summary.py`, per task-GAPI-report.md) — a single hardcoded "too
// long" sentence was wrong for every other reason under the same code.
import { describe, expect, it } from "vitest";
import { PpmGitServiceError } from "@/services/ppm-git.service";
import { getGitObjectSearchErrorMessage, getWorkSummaryErrorMessage } from "@/components/ppm-git/insert/errors";

describe("getGitObjectSearchErrorMessage", () => {
  it("gives GIT_PERMISSION_DENIED (by code or by a bare 403) its own understandable sentence about «Код»", () => {
    expect(getGitObjectSearchErrorMessage(new PpmGitServiceError("ignored", { code: "GIT_PERMISSION_DENIED" }))).toBe(
      "Нет доступа к разделу «Код» этого проекта."
    );
    expect(getGitObjectSearchErrorMessage(new PpmGitServiceError("ignored", { status: 403 }))).toBe(
      "Нет доступа к разделу «Код» этого проекта."
    );
  });

  it("otherwise shows the API's own message for a PpmGitServiceError", () => {
    expect(getGitObjectSearchErrorMessage(new PpmGitServiceError("Не удалось выполнить Git-операцию."))).toBe(
      "Не удалось выполнить Git-операцию."
    );
  });

  it("shows a plain Error's own message", () => {
    expect(getGitObjectSearchErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to a generic Russian sentence for anything else (no message, not an Error at all)", () => {
    expect(getGitObjectSearchErrorMessage(new PpmGitServiceError(""))).toBe(
      "Не удалось получить коммиты и PR проекта."
    );
    expect(getGitObjectSearchErrorMessage("not an error")).toBe("Не удалось получить коммиты и PR проекта.");
  });
});

describe("getWorkSummaryErrorMessage", () => {
  it("gives GIT_PERMISSION_DENIED its own sentence, same as the search dialog's style", () => {
    expect(getWorkSummaryErrorMessage(new PpmGitServiceError("ignored", { code: "GIT_PERMISSION_DENIED" }))).toBe(
      "Нет доступа к этому проекту."
    );
    expect(getWorkSummaryErrorMessage(new PpmGitServiceError("ignored", { status: 403 }))).toBe(
      "Нет доступа к этому проекту."
    );
  });

  it(
    "review round 2 (#1): shows the API's own precise message for WORK_SUMMARY_RANGE_INVALID, not a hardcoded " +
      "'too long' sentence — the same code also covers a malformed/missing date and 'from' after 'to'",
    () => {
      expect(
        getWorkSummaryErrorMessage(
          new PpmGitServiceError("Период длиннее 92 дней. Сократите диапазон.", {
            code: "WORK_SUMMARY_RANGE_INVALID",
            details: { max_days: 92 },
          })
        )
      ).toBe("Период длиннее 92 дней. Сократите диапазон.");
      expect(
        getWorkSummaryErrorMessage(
          new PpmGitServiceError("Дата начала должна быть не позже даты окончания.", {
            code: "WORK_SUMMARY_RANGE_INVALID",
          })
        )
      ).toBe("Дата начала должна быть не позже даты окончания.");
      expect(
        getWorkSummaryErrorMessage(new PpmGitServiceError("Некорректная дата.", { code: "WORK_SUMMARY_RANGE_INVALID" }))
      ).toBe("Некорректная дата.");
    }
  );

  it("falls back to the generic sentence only when WORK_SUMMARY_RANGE_INVALID somehow carries no message", () => {
    expect(getWorkSummaryErrorMessage(new PpmGitServiceError("", { code: "WORK_SUMMARY_RANGE_INVALID" }))).toBe(
      "Не удалось собрать сводку за период."
    );
  });

  it("shows the API's own message for any other code", () => {
    expect(getWorkSummaryErrorMessage(new PpmGitServiceError("Проект не найден.", { code: "NOT_FOUND" }))).toBe(
      "Проект не найден."
    );
  });

  it("shows a plain Error's own message, and falls back for anything with no message at all", () => {
    expect(getWorkSummaryErrorMessage(new Error("boom"))).toBe("boom");
    expect(getWorkSummaryErrorMessage("not an error")).toBe("Не удалось собрать сводку за период.");
  });
});
