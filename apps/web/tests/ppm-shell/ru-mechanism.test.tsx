/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R, fix round 1: the mechanism behind the Russian interface — ppmText/usePpmCount (hooks/use-ppm-text),
// server error toasts (ppm-shell/server-error + hooks/use-ppm-server-error) and the date language wiring
// (PpmDateLanguage inside PpmLocaleBootstrap).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDateFormatLanguage, renderFormattedDate, setDateFormatLanguage } from "@plane/utils";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { PpmDateLanguage, PpmLocaleBootstrap } from "@/components/ppm-shell/locale-bootstrap";
import { extractPpmServerErrorText, matchPpmServerError } from "@/components/ppm-shell/server-error";
import { resolvePpmServerError } from "@/hooks/use-ppm-server-error";
import { formatPpmCount, isPpmRussianUi, resolvePpmText, usePpmCount, usePpmText } from "@/hooks/use-ppm-text";

const i18n = vi.hoisted(() => ({ locale: "ru" }));
vi.mock("@plane/i18n", () => ({
  LANGUAGE_STORAGE_KEY: "userLanguage",
  applyTranslationOverlay: () => undefined,
  setLanguage: async () => undefined,
  useTranslation: () => ({ currentLocale: i18n.locale, t: (key: string) => key }),
}));

// PpmLocaleBootstrap turns ready in an effect, once the RU overlay and the language have loaded. Static rendering runs
// no effects, so the test hands it the ready state (its `isReady` is the only boolean state rendered in this file).
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) =>
    typeof initial === "boolean" ? [true, () => undefined] : react.useState(initial)) as typeof react.useState;
  return { ...react, useState };
});

const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
const en = (key: TPpmTranslationKey) => getPpmTranslation("en", key);

afterEach(() => {
  setDateFormatLanguage("en");
  i18n.locale = "ru";
  vi.unstubAllEnvs();
});

// The owner's screenshot: the delete dialog of a work item.
const UPSTREAM_DELETE_TITLE = "Delete Work item";
const UPSTREAM_DELETE_CONTENT =
  "Are you sure you want to delete work item BIO-4 ? All of the data related to the work item will be permanently removed. This action cannot be undone.";

describe("ppmText: the PPM Russian text only in the Russian interface of the shell", () => {
  it("is on only when the shell is on and the interface language is Russian", () => {
    expect(isPpmRussianUi(true, "ru")).toBe(true);
    expect(isPpmRussianUi(true, "ru-RU")).toBe(true);
    expect(isPpmRussianUi(true, "en")).toBe(false);
    expect(isPpmRussianUi(true, "de")).toBe(false);
    expect(isPpmRussianUi(true, undefined)).toBe(false);
    expect(isPpmRussianUi(false, "ru")).toBe(false);
  });

  it("fills the placeholders of the Russian phrase and keeps the upstream text byte for byte otherwise", () => {
    expect(resolvePpmText(true, ru, "ui.confirm.delete_task_content", UPSTREAM_DELETE_CONTENT, { id: "BIO-4" })).toBe(
      "Удалить задачу BIO-4? Задача и все её данные будут удалены без возможности восстановления."
    );
    // Plane's own quirks («BIO-4 ?», «Work item») stay in English: the PPM text never replaces it there.
    expect(resolvePpmText(false, en, "ui.confirm.delete_task_content", UPSTREAM_DELETE_CONTENT, { id: "BIO-4" })).toBe(
      UPSTREAM_DELETE_CONTENT
    );
  });

  it("usePpmText follows the interface language", () => {
    function Probe() {
      const ppmText = usePpmText();
      return <b>{ppmText("ui.confirm.delete_task_title", UPSTREAM_DELETE_TITLE)}</b>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<b>Удалить задачу</b>");
    i18n.locale = "en";
    expect(renderToStaticMarkup(<Probe />)).toBe(`<b>${UPSTREAM_DELETE_TITLE}</b>`);
  });
});

describe("usePpmCount: plural forms by the interface language", () => {
  it("declines Russian counts by CLDR one/few/many", () => {
    const labels = (count: number) => formatPpmCount("ui.count.labels", count, "ru", ru);
    expect([1, 2, 5, 11, 21, 22, 0].map(labels)).toEqual([
      "1 метка",
      "2 метки",
      "5 меток",
      "11 меток",
      "21 метка",
      "22 метки",
      "0 меток",
    ]);
  });

  it("keeps the former English of each place in English", () => {
    expect(formatPpmCount("ui.count.labels", 1, "en", en)).toBe("1 Labels");
    expect(formatPpmCount("ui.count.modules", 1, "en", en)).toBe("1 Module");
    expect(formatPpmCount("ui.count.modules", 3, "en", en)).toBe("3 Modules");
    expect(formatPpmCount("ui.count.members", 1, "en", en)).toBe("1 Members");
  });

  it("the hook picks the form and the dictionary of the current language (the assignees tooltip)", () => {
    function Probe({ count }: { count: number }) {
      const ppmCount = usePpmCount();
      return <i>{ppmCount("ui.count.assignees", count)}</i>;
    }
    const render = (count: number) => renderToStaticMarkup(<Probe count={count} />);
    expect([1, 3, 7, 21].map(render)).toEqual([
      "<i>1 исполнитель</i>",
      "<i>3 исполнителя</i>",
      "<i>7 исполнителей</i>",
      "<i>21 исполнитель</i>",
    ]);
    i18n.locale = "en";
    expect([1, 3].map(render)).toEqual(["<i>1 Assignee</i>", "<i>3 Assignees</i>"]);
  });
});

describe("server error toasts (ppm-shell/server-error, hooks/use-ppm-server-error)", () => {
  it("reads the error text from every body shape the web services rethrow", () => {
    expect(extractPpmServerErrorText({ error: "E" })).toBe("E");
    expect(extractPpmServerErrorText({ detail: "D" })).toBe("D");
    expect(extractPpmServerErrorText({ message: "M" })).toBe("M");
    expect(extractPpmServerErrorText({ name: ["This field may not be blank."] })).toBe("This field may not be blank.");
    expect(extractPpmServerErrorText("plain")).toBe("plain");
    expect(extractPpmServerErrorText({})).toBeUndefined();
    expect(extractPpmServerErrorText(undefined)).toBeUndefined();
  });

  it("explains every known API message of the task, sprint and direction flows in Russian", () => {
    const cases: Array<[string, TPpmTranslationKey]> = [
      [
        "You have a cycle already on the given dates, if you want to create a draft cycle you can do that by removing dates",
        "ui.error.cycle_dates_overlap",
      ],
      [
        "You already have a cycle on the given dates, if you want to create a draft cycle, remove the dates.",
        "ui.error.cycle_dates_overlap",
      ],
      ["The Cycle has already been completed so it cannot be edited", "ui.error.cycle_completed_edit"],
      ["The Cycle has already been completed so no new issues can be added", "ui.error.cycle_completed_add"],
      ["Start date cannot exceed end date", "ui.error.start_after_end"],
      ["Start date cannot exceed target date", "ui.error.start_after_end"],
      ["Start date and end date both are required", "ui.error.dates_both_required"],
      ["Only admin or creator can delete the work item", "ui.error.delete_admin_or_creator"],
      ["You don't have the required permissions.", "ui.error.no_permission"],
      ["You are not allowed to view this issue", "ui.error.no_permission"],
      ["You do not have access to this project.", "ui.error.no_permission"],
      ["Module with this name already exists", "ui.error.module_name_exists"],
      ["Label with the same name already exists in the project", "ui.error.label_name_exists"],
      ["LABEL_NAME_ALREADY_EXISTS", "ui.error.label_name_exists"],
      ["URL already exists.", "ui.error.link_exists"],
      ["Invalid URL format.", "ui.error.link_invalid"],
      ["The state is not empty, only empty states can be deleted", "ui.toast.state_has_work_items"],
      ["Issues are required", "ui.error.select_work_items"],
      ["Group by and sub group by cannot have same parameters", "ui.error.group_by_same"],
      ["Module not found", "ui.error.not_found"],
      ["The required object does not exist.", "ui.error.not_found"],
      ["Name is required", "ui.error.name_required"],
      ["This field may not be blank.", "ui.error.name_required"],
    ];
    for (const [message, key] of cases) {
      expect(matchPpmServerError(message), message).toBe(key);
      expect(ru(key), key).toMatch(/[а-яё]/i);
    }
    expect(matchPpmServerError("Something exploded")).toBeUndefined();
    expect(matchPpmServerError(undefined)).toBeUndefined();
  });

  it("titles the toast by the flow; unknown → the server text under «Что-то пошло не так»; no text → the flow message", () => {
    const ppm = { title: "ui.cycle.create_failed_title", message: "ui.cycle.create_failed" } as const;
    const upstream = { title: "Error!", message: "Error in creating cycle. Please try again." };
    expect(resolvePpmServerError(true, ru, { error: "Start date cannot exceed end date" }, ppm, upstream)).toEqual({
      title: "Не удалось создать спринт",
      message: "Дата начала должна быть не позже даты окончания.",
    });
    expect(resolvePpmServerError(true, ru, { error: "Something exploded" }, ppm, upstream)).toEqual({
      title: "Что-то пошло не так",
      message: "Something exploded",
    });
    expect(resolvePpmServerError(true, ru, {}, ppm, upstream)).toEqual({
      title: "Не удалось создать спринт",
      message: "Не удалось создать спринт. Попробуйте ещё раз.",
    });
    // English interface and PPM_SHELL_ENABLED=0: the upstream toast untouched.
    expect(resolvePpmServerError(false, ru, { error: "Start date cannot exceed end date" }, ppm, upstream)).toBe(
      upstream
    );
  });
});

function DateProbe({ format = renderFormattedDate }: { format?: typeof renderFormattedDate }) {
  return <span>{format("2026-09-28")}</span>;
}

describe("the date language is wired into the PPM locale bootstrap", () => {
  it("PpmDateLanguage sets the interface language before its children format a date", () => {
    expect(renderToStaticMarkup(<PpmDateLanguage>{<DateProbe />}</PpmDateLanguage>)).toBe("<span>28 сент. 2026</span>");
    expect(getDateFormatLanguage()).toBe("ru");
    i18n.locale = "en";
    expect(renderToStaticMarkup(<PpmDateLanguage>{<DateProbe />}</PpmDateLanguage>)).toBe("<span>Sep 28, 2026</span>");
  });

  it("the ready PpmLocaleBootstrap renders the app with dates in the interface language", () => {
    expect(renderToStaticMarkup(<PpmLocaleBootstrap>{<DateProbe />}</PpmLocaleBootstrap>)).toBe(
      "<span>28 сент. 2026</span>"
    );
    i18n.locale = "en";
    expect(renderToStaticMarkup(<PpmLocaleBootstrap>{<DateProbe />}</PpmLocaleBootstrap>)).toBe(
      "<span>Sep 28, 2026</span>"
    );
  });

  it("with PPM_SHELL_ENABLED=0 the dates stay as upstream renders them, whatever the language", async () => {
    vi.stubEnv("PPM_SHELL_ENABLED", "0");
    vi.resetModules();
    const bootstrap = await import("@/components/ppm-shell/locale-bootstrap");
    const utils = await import("@plane/utils");
    expect(
      renderToStaticMarkup(
        <bootstrap.PpmLocaleBootstrap>{<DateProbe format={utils.renderFormattedDate} />}</bootstrap.PpmLocaleBootstrap>
      )
    ).toBe("<span>Sep 28, 2026</span>");
    expect(utils.getDateFormatLanguage()).toBe("en");
  });
});
