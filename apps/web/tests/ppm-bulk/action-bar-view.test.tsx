// Линия B (B2): панель действий вместо рекламы — «Выбрано: N», «Статус ▾», «Исполнитель ▾», «Спринт ▾», «Удалить»,
// «Снять выделение» (Esc); неактивные кнопки фокусируемы и объясняют причину; пока идёт действие, всё неактивно.
// Вид без хуков — вызываем компоненты и нажимаем кнопки (env node), меню — строкой renderToStaticMarkup.
import { readFileSync, readdirSync } from "node:fs";
import { getPpmTranslation } from "@ppm/brand";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PpmBulkActionBarView, PpmBulkButton } from "@/components/issues/bulk-operations/action-bar";
import { PpmBulkPicker, shouldPpmBulkPickerConsumeKeyDown } from "@/components/issues/bulk-operations/bulk-picker";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { hostElements, textOf } from "../ppm-git/element-tree";

const ru = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation("ru", key);

function bar(overrides: Partial<Parameters<typeof PpmBulkActionBarView>[0]> = {}) {
  const props: Parameters<typeof PpmBulkActionBarView>[0] = {
    regionLabel: ru("bulk.region_label"),
    countLabel: "Выбрано: 3 задачи",
    busy: false,
    busyLabel: ru("bulk.busy"),
    isDesignV2: true,
    pickers: <span data-testid="pickers" />,
    deleteLabel: ru("bulk.delete"),
    deleteHint: null,
    onDelete: vi.fn(),
    clearLabel: ru("bulk.clear"),
    onClear: vi.fn(),
    ...overrides,
  };
  return { props, tree: PpmBulkActionBarView(props) };
}

const buttons = (tree: ReturnType<typeof PpmBulkActionBarView>) =>
  hostElements(tree).filter((element) => element.type === "button");
const named = (tree: ReturnType<typeof PpmBulkActionBarView>, name: string) =>
  buttons(tree).find((button) => textOf(button.props.children as never).includes(name));
const click = (button: { props: Record<string, unknown> } | undefined) =>
  (button?.props.onClick as (() => void) | undefined)?.();

describe("панель действий", () => {
  it("область с названием, счётчик в живой области, подсказка Esc", () => {
    const { tree } = bar();
    const region = hostElements(tree).find((element) => element.props.role === "region");
    expect(region?.props["aria-label"]).toBe("Действия с выделенными задачами");
    const live = hostElements(tree).find((element) => element.props["aria-live"] === "polite");
    expect(textOf(live?.props.children as never)).toBe("Выбрано: 3 задачи");
    expect(textOf(tree)).toContain("Esc");
    expect(hostElements(tree).some((element) => element.props["data-testid"] === "pickers")).toBe(true);
  });

  it("«Удалить» и «Снять выделение» работают", () => {
    const { tree, props } = bar();
    click(named(tree, "Удалить"));
    click(named(tree, "Снять выделение"));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("нет прав на удаление — кнопка неактивна, но фокусируема и объясняет причину", () => {
    const hint = ru("bulk.delete_no_rights_hint");
    const { tree, props } = bar({ deleteHint: hint });
    const remove = named(tree, "Удалить");
    expect(remove?.props["aria-disabled"]).toBe(true);
    expect(remove?.props.disabled).toBeUndefined();
    const describedBy = remove?.props["aria-describedby"] as string;
    const description = hostElements(tree).find((element) => element.props.id === describedBy);
    expect(textOf(description?.props.children as never)).toBe(
      "Удалить можно только свои задачи — или любые, если вы администратор проекта"
    );
    click(remove);
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("часть задач удалить нельзя — «Удалить» активна, а «Можно удалить K из N» видно заранее", () => {
    const note = formatPpmTemplate(ru("bulk.delete_partial_note"), { allowed: 2, total: 4 });
    expect(note).toBe("Можно удалить 2 из 4");
    const { tree, props } = bar({ deleteNote: note });
    const remove = named(tree, "Удалить");
    expect(remove?.props["aria-disabled"]).toBeUndefined();
    expect(remove?.props.title).toBe("Можно удалить 2 из 4");
    const description = hostElements(tree).find((element) => element.props.id === remove?.props["aria-describedby"]);
    expect(textOf(description?.props.children as never)).toBe("Можно удалить 2 из 4");
    click(remove);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("пока идёт действие — всё неактивно и видно «Выполняется…»", () => {
    const { tree, props } = bar({ busy: true });
    const region = hostElements(tree).find((element) => element.props.role === "region");
    expect(region?.props["aria-busy"]).toBe(true);
    expect(textOf(tree)).toContain("Выполняется…");
    for (const button of buttons(tree)) {
      expect(button.props["aria-disabled"]).toBe(true);
      click(button);
    }
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onClear).not.toHaveBeenCalled();
  });

  it("кнопка без подсказки — обычная; с подсказкой — aria-disabled и title", () => {
    const onClick = vi.fn();
    const plain = hostElements(PpmBulkButton({ id: "x", label: "Статус", hint: null, onClick }))[0];
    expect(plain.props["aria-disabled"]).toBeUndefined();
    click(plain);
    expect(onClick).toHaveBeenCalledTimes(1);
    const off = hostElements(
      PpmBulkButton({ id: "x", label: "Статус", hint: "Выделите задачи одного проекта", onClick })
    )[0];
    expect(off.props["aria-disabled"]).toBe(true);
    expect(off.props.title).toBe("Выделите задачи одного проекта");
  });
});

describe("меню статуса, исполнителя и спринта", () => {
  // useDropdown спрашивает платформу у window.navigator (env node — окна нет).
  beforeEach(() => vi.stubGlobal("window", { navigator: { userAgent: "node" } }));
  afterEach(() => vi.unstubAllGlobals());
  const texts = {
    searchPlaceholder: ru("bulk.search"),
    noMatchesText: ru("bulk.no_matches"),
    loadingText: ru("bulk.loading"),
    emptyText: ru("bulk.no_options"),
  };

  it("задачи нескольких проектов — «Статус» неактивен с подсказкой «Выделите задачи одного проекта»", () => {
    const html = renderToStaticMarkup(
      <PpmBulkPicker
        id="ppm-bulk-status"
        label={ru("bulk.status")}
        hint={ru("bulk.one_project_hint")}
        options={[]}
        onSelect={vi.fn()}
        {...texts}
      />
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Выделите задачи одного проекта");
    expect(html).toContain("Статус");
    // Та же кнопка, что и у активного меню: фокус не теряется, когда меню становится неактивным.
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain('disabled=""');
  });

  it("пока идёт действие — меню неактивно без подсказки", () => {
    const html = renderToStaticMarkup(
      <PpmBulkPicker
        id="ppm-bulk-sprint"
        label={ru("bulk.sprint")}
        hint={null}
        busy
        options={[{ value: "c-1", label: "Спринт 10" }]}
        onSelect={vi.fn()}
        {...texts}
      />
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("aria-describedby");
  });

  it("задачи одного проекта — кнопка открывает список (aria-haspopup), закрыто по умолчанию", () => {
    const html = renderToStaticMarkup(
      <PpmBulkPicker
        id="ppm-bulk-assignee"
        label={ru("bulk.assignee")}
        hint={null}
        options={[{ value: "u-1", label: "Анна" }]}
        onSelect={vi.fn()}
        menuHint={ru("bulk.assignee_replace_hint")}
        {...texts}
      />
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-disabled="true"');
    // Кнопка меню достижима клавишей Tab (Combobox.Button из Headless UI ставил бы tabindex="-1").
    expect(html).not.toContain('tabindex="-1"');
    expect(html).toContain("Исполнитель");
  });
});

describe("D-2: второй Esc на кнопке меню (уже закрытого) снимает выделение", () => {
  it("неактивное меню клавиш не получает — ни Esc, ни другие", () => {
    expect(shouldPpmBulkPickerConsumeKeyDown("Escape", true, true)).toBe(false);
    expect(shouldPpmBulkPickerConsumeKeyDown("Escape", false, true)).toBe(false);
    expect(shouldPpmBulkPickerConsumeKeyDown("Enter", false, true)).toBe(false);
  });

  it("меню открыто: Esc — наш (закрывает меню, до панели не доходит)", () => {
    expect(shouldPpmBulkPickerConsumeKeyDown("Escape", true, false)).toBe(true);
  });

  it("меню уже закрыто: Esc — не наш (D-2 — должен дойти до панели и снять выделение)", () => {
    expect(shouldPpmBulkPickerConsumeKeyDown("Escape", false, false)).toBe(false);
  });

  it("остальные клавиши всегда наши, открыто меню или нет (Enter открывает, стрелки листают)", () => {
    for (const isOpen of [true, false]) {
      expect(shouldPpmBulkPickerConsumeKeyDown("Enter", isOpen, false)).toBe(true);
      expect(shouldPpmBulkPickerConsumeKeyDown("ArrowDown", isOpen, false)).toBe(true);
      expect(shouldPpmBulkPickerConsumeKeyDown("Tab", isOpen, false)).toBe(true);
    }
  });
});

describe("исходники панели", () => {
  const DIR = new URL("../../core/components/issues/bulk-operations/", import.meta.url);
  const files = readdirSync(DIR).filter((name) => name.endsWith(".tsx") && name !== "upgrade-banner.tsx");
  const sources = files.map((name) => [name, readFileSync(new URL(name, DIR), "utf8")] as const);

  it("без английских строк в разметке: подписи — только из словаря PPM (bulk.*)", () => {
    for (const [name, source] of sources) {
      // Текст между тегами (`=> Promise<…>` у стрелочных функций — не текст).
      const jsxText = [...source.matchAll(/(?<!=)>\s*([A-Za-z][A-Za-z ,.'!?-]{2,})\s*</g)].map((match) => match[1]);
      expect(jsxText, name).toEqual([]);
    }
  });

  it("без текста меньше 11px и иконок-кнопок без имени", () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/\btext-(9|10)\b|text-\[(?:[0-9]|10)px\]/);
      const iconOnly = [...source.matchAll(/<button\b[^>]*>/gs)]
        .map((match) => match[0])
        .filter((tag) => /icon/i.test(tag) && !/aria-label=|aria-labelledby=/.test(tag));
      expect(iconOnly, name).toEqual([]);
    }
  });

  it("реклама платной версии больше не показывается", () => {
    const root = readFileSync(new URL("root.tsx", DIR), "utf8");
    expect(root).not.toContain("BulkOperationsUpgradeBanner");
  });
});
