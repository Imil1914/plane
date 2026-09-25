import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PpmCuratorColumnView } from "@/components/ppm-tasks/curator-column-view";
import type { TPpmCuratorViewProps } from "@/components/ppm-tasks/curator-column-view";

const LABELS: TPpmCuratorViewProps["labels"] = {
  title: "Требует внимания",
  hide: "Скрыть колонку",
  show: "Показать «Требует внимания»",
  blocked: "Заблокировано",
  blockedEmpty: "Заблокированных задач нет",
  review: "Ждёт проверки",
  reviewEmpty: "На проверке ничего нет",
  overdue: "Просрочено",
  overdueEmpty: "Просроченных задач нет",
  recent: "Недавно изменённые",
  recentEmpty: "Задач пока нет",
  hint: "Нажмите на задачу — справа откроется её карточка, а эта колонка спрячется.",
  loading: "Загружаем…",
  error: "Не удалось загрузить сводку",
  retry: "Повторить",
};
const base: TPpmCuratorViewProps = {
  labels: LABELS,
  status: "ready",
  collapsed: false,
  attentionCount: 1,
  blocked: {
    count: 1,
    entries: [
      {
        id: "i15",
        href: "/ws/browse/ROBOT-15/",
        identifier: "ROBOT-15",
        title: "Сценарий сортировки по 4 цветам",
        byline: "Даша П.",
        detail: { prefix: "Ждёт ", code: "ROBOT-12", suffix: " · Откалибровать датчик цвета" },
      },
    ],
  },
  review: null,
  overdue: { count: 0, entries: [], nearest: { prefix: "Ближайший срок — ", code: "ROBOT-12", suffix: ", 26 сент." } },
  recent: [
    {
      id: "i12",
      href: "/ws/browse/ROBOT-12/",
      identifier: "ROBOT-12",
      title: "Откалибровать датчик цвета",
      initials: "ДП",
      byline: "Даша П. · сегодня, 11:52",
    },
  ],
  onToggleCollapsed: () => undefined,
  onRetry: () => undefined,
  onOpenIssue: () => undefined,
};

/** Text a screen reader gets from each section heading (tags and React's text separators removed). */
const headingTexts = (html: string) =>
  [...html.matchAll(/<h3 class="ppm-curator__section-title">([\s\S]*?)<\/h3>/g)].map((m) =>
    m[1].replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "")
  );

describe("PpmCuratorColumnView", () => {
  it("separates the section name from its count for screen readers (visually unchanged: flex gap)", () => {
    const html = renderToStaticMarkup(
      <PpmCuratorColumnView {...base} review={{ count: 2, entries: [] }} overdue={{ count: 0, entries: [] }} />
    );
    expect(headingTexts(html)).toEqual(["Заблокировано 1", "Ждёт проверки 2", "Просрочено 0"]);
  });

  it("renders sections, hides review without a review state and shows the nearest due date", () => {
    const html = renderToStaticMarkup(<PpmCuratorColumnView {...base} />);
    expect(html).toContain('aria-label="Требует внимания"');
    expect(html).toContain("min-[1440px]:flex");
    expect(html).toContain("Заблокировано");
    expect(html).not.toContain("Ждёт проверки");
    expect(html).toContain("Просроченных задач нет");
    expect(html).toContain("Ближайший срок — ");
    expect(html).toContain("Даша П. · сегодня, 11:52");
    expect(html).toContain('aria-label="Скрыть колонку"');
    expect(html).toContain(LABELS.hint);
  });

  it("renders empty states and the review section when it exists", () => {
    const html = renderToStaticMarkup(
      <PpmCuratorColumnView
        {...base}
        attentionCount={0}
        blocked={{ count: 0, entries: [] }}
        review={{ count: 0, entries: [] }}
        overdue={{ count: 0, entries: [] }}
        recent={[]}
      />
    );
    expect(html).toContain("Заблокированных задач нет");
    expect(html).toContain("На проверке ничего нет");
    expect(html).toContain("Задач пока нет");
    expect(html).not.toContain("Ближайший срок");
  });

  it("collapses to a rail with a named show button", () => {
    const html = renderToStaticMarkup(<PpmCuratorColumnView {...base} collapsed />);
    expect(html).toContain('aria-label="Показать «Требует внимания»"');
    expect(html).not.toContain("Заблокировано");
  });

  it("shows loading and error states", () => {
    expect(renderToStaticMarkup(<PpmCuratorColumnView {...base} status="loading" />)).toContain("Загружаем…");
    const error = renderToStaticMarkup(<PpmCuratorColumnView {...base} status="error" />);
    expect(error).toContain("Не удалось загрузить сводку");
    expect(error).toContain(">Повторить</button>");
  });
});
