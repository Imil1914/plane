/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R2-1: the notification card in the Russian PPM interface. Upstream glues «<actor> <verb> <field> to <value>.»
// from English pieces («set due date to», «updated priority to high»); the PPM card picks a whole Russian phrase per
// field and verb (the same phrases as the work item activity feed) and shows the value in it.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import {
  resolvePpmNotificationPhrase,
  toPpm24HourTime,
} from "@/components/workspace-notifications/ppm-notification-text";

const sentence = (data: Parameters<typeof resolvePpmNotificationPhrase>[0], renderCommentBox = false) => {
  const { phrase, value } = resolvePpmNotificationPhrase(data, renderCommentBox);
  return formatPpmTemplate(getPpmTranslation("ru", phrase), { value: value ?? "" });
};

describe("notification phrases (line R2-1)", () => {
  it("names each event with a whole Russian phrase", () => {
    expect(sentence({ field: "state", verb: "updated", newValue: "В работе", oldValue: "Бэклог" })).toBe(
      "изменил(а) статус на В работе"
    );
    expect(sentence({ field: "assignees", verb: "updated", newValue: "Иван", oldValue: "" })).toBe(
      "назначил(а) исполнителя Иван"
    );
    expect(sentence({ field: "assignees", verb: "updated", newValue: "", oldValue: "Иван" })).toBe(
      "снял(а) исполнителя Иван"
    );
    expect(sentence({ field: "labels", verb: "updated", newValue: "", oldValue: "bug" })).toBe("убрал(а) метку bug");
    expect(sentence({ field: "cycles", verb: "created", newValue: "Спринт 1" })).toBe(
      "добавил(а) задачу в спринт Спринт 1"
    );
    expect(sentence({ field: "cycles", verb: "deleted", newValue: "", oldValue: "Спринт 1" })).toBe(
      "убрал(а) задачу из спринта Спринт 1"
    );
    expect(sentence({ field: "modules", verb: "updated", newValue: "Механика" })).toBe(
      "изменил(а) направление на Механика"
    );
    expect(sentence({ field: "None", verb: "created" })).toBe("создал(а) задачу и назначил(а) её вам");
    expect(sentence({ field: "archived_at", verb: "updated", newValue: "restore" })).toBe(
      "восстановил(а) задачу из архива"
    );
    expect(sentence({ field: "intake", verb: "1", newValue: "Accepted" })).toBe("принял(а) заявку");
    expect(sentence({ field: "link", verb: "deleted", newValue: "" })).toBe("удалил(а) ссылку");
  });

  it("treats the API's «None» as an empty value (a removed date is not «set to None»)", () => {
    expect(sentence({ field: "target_date", verb: "updated", newValue: "None", oldValue: "2026-09-28" })).toBe(
      "убрал(а) срок"
    );
    expect(sentence({ field: "start_date", verb: "updated", newValue: "" })).toBe("убрал(а) дату начала");
    expect(resolvePpmNotificationPhrase({ field: "target_date", verb: "updated", newValue: "2026-09-28" })).toEqual({
      phrase: "ui.activity.due_date_set",
      value: expect.any(String),
    });
  });

  it("keeps the priority key for the PPM priority name and formats minutes of a time estimate", () => {
    expect(resolvePpmNotificationPhrase({ field: "priority", verb: "updated", newValue: "high" })).toEqual({
      phrase: "ui.activity.priority",
      value: "high",
      priority: "high",
    });
    expect(resolvePpmNotificationPhrase({ field: "estimate_time", verb: "updated", newValue: "130" }).phrase).toBe(
      "ui.activity.estimate_set"
    );
  });

  it("shows the comment in the sentence, or only the verb when the comment box renders it", () => {
    expect(sentence({ field: "comment", verb: "created", newValue: "<p>Готово к проверке</p>" })).toBe(
      "прокомментировал(а): Готово к проверке"
    );
    expect(sentence({ field: "comment", verb: "created", newValue: "<p>Готово</p>" }, true)).toBe(
      "прокомментировал(а)"
    );
    expect(sentence({ field: "comment", verb: "deleted", newValue: "" })).toBe("удалил(а) комментарий");
  });

  it("falls back to a neutral phrase for an unknown field instead of an English field name", () => {
    expect(sentence({ field: "vote", verb: "updated", newValue: "1" })).toBe("обновил(а) задачу");
    expect(sentence({ field: "state", verb: "updated", newValue: "" })).toBe("обновил(а) задачу");
  });

  it("has its own phrase for every field of the upstream content map", () => {
    const file = new URL(
      "../../core/components/workspace-notifications/sidebar/notification-card/content.tsx",
      import.meta.url
    );
    const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fields: string[] = [];
    source.forEachChild(function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "BASE_NOTIFICATION_CONTENT_MAP" &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      )
        for (const property of node.initializer.properties) if (property.name) fields.push(property.name.getText());
      node.forEachChild(visit);
    });
    expect(fields.length).toBeGreaterThan(10);
    for (const field of fields)
      for (const verb of ["created", "updated", "deleted"])
        expect(
          resolvePpmNotificationPhrase({ field, verb, newValue: "x", oldValue: "y" }).phrase,
          `${field} / ${verb}`
        ).not.toBe("ui.notification.updated");
  });
});

describe("snooze time in the Russian interface: 24 hours instead of AM/PM", () => {
  it("turns the 12-hour option and the half of the day into a 24-hour time", () => {
    expect(toPpm24HourTime("12:00", "AM")).toBe("00:00");
    expect(toPpm24HourTime("01:30", "AM")).toBe("01:30");
    expect(toPpm24HourTime("12:30", "PM")).toBe("12:30");
    expect(toPpm24HourTime("02:30", "PM")).toBe("14:30");
    expect(toPpm24HourTime("11:30", "PM")).toBe("23:30");
  });
});
