// Линия B, раунд 3: в подтверждении массового удаления первый фокус — на «Отмена», чтобы два Enter подряд не удаляли
// N задач. Общий AlertModalCore (packages/ui) получил необязательный initialFocus; по умолчанию — как было (фокус на
// основной кнопке через tabIndex=1: Headless UI ставит первый фокус на элемент с наименьшим положительным tabIndex).
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { describe, expect, it } from "vitest";

type TProps = Record<string, unknown> & { children?: ReactNode };

/** Кнопки диалога в порядке разметки — без запуска компонентов (AlertModalCore без хуков). */
function buttonsOf(node: ReactNode): ReactElement<TProps>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => buttonsOf(child));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<TProps>;
  if (element.type === Button) return [element];
  return buttonsOf(element.props.children);
}

const base = {
  isOpen: true,
  title: "Удалить 3 задачи?",
  content: "Это действие нельзя отменить.",
  handleClose: () => undefined,
  handleSubmit: () => undefined,
  isSubmitting: false,
  primaryButtonText: { default: "Удалить", loading: "Удалить" },
  secondaryButtonText: "Отмена",
};

describe("первый фокус в диалоге подтверждения", () => {
  it("по умолчанию — на основной кнопке, как у всех остальных диалогов", () => {
    const [cancel, submit] = buttonsOf(AlertModalCore(base));
    expect(cancel.props.children).toBe("Отмена");
    expect(cancel.props.tabIndex).toBeUndefined();
    expect(submit.props.tabIndex).toBe(1);
  });

  it('initialFocus="secondary" — на «Отмена»; Enter по открытому диалогу не удаляет', () => {
    const [cancel, submit] = buttonsOf(AlertModalCore({ ...base, initialFocus: "secondary" }));
    expect(cancel.props.tabIndex).toBe(1);
    expect(submit.props.tabIndex).toBeUndefined();
  });
});
