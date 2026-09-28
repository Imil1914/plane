// G2.1 · линия C, раунд E (правка D-5, task-E-report.md §6): инициалы аватарки брали первый *символ* второго
// «слова» имени, даже если это открывающая скобка — «Посторонний (демо)» → «П(». Теперь буква слова — его первая
// *буква* (цифры/скобки/пунктуация/эмодзи пропускаются), а слово вовсе без букв не считается словом. Env node, без DOM.
import { describe, expect, it } from "vitest";
import { assigneeInitials } from "@/components/ppm-canvas/canvas-assignee-picker";

describe("раунд E · D-5: инициалы аватарки — буквы слов, а не первые символы", () => {
  it("скобка после имени не портит вторую инициалу: «Посторонний (демо)» → «ПД», не «П(»", () => {
    expect(assigneeInitials("Посторонний (демо)")).toBe("ПД");
    // Скобка вплотную, без пробела — то же слово, но правило «первая буква слова» не меняется.
    expect(assigneeInitials("Гость(демо)")).toBe("Г");
  });

  it("слово из одних цифр не считается словом и не занимает место в «первых двух»: «Сотрудник 1 ROBOT (демо)» → «СR»", () => {
    expect(assigneeInitials("Сотрудник 1 ROBOT (демо)")).toBe("СR");
  });

  it("обычные имя и фамилия — без регресса: «Anna Petrova» → «AP»", () => {
    expect(assigneeInitials("Anna Petrova")).toBe("AP");
  });

  it("одно слово — одна его буква, как и раньше («Madonna» → «M»)", () => {
    expect(assigneeInitials("Madonna")).toBe("M");
  });

  it("букв нет вовсе (пусто или только цифры/эмодзи) — первый символ e-mail, если он есть", () => {
    expect(assigneeInitials("", "jane@example.com")).toBe("J");
    expect(assigneeInitials("42", "z@example.com")).toBe("Z");
    expect(assigneeInitials("🙂🙂", "  q@example.com")).toBe("Q");
  });

  it("букв нет и e-mail не дан (или пуст) — «?»", () => {
    expect(assigneeInitials("")).toBe("?");
    expect(assigneeInitials("", null)).toBe("?");
    expect(assigneeInitials("", "")).toBe("?");
    expect(assigneeInitials("🙂🙂")).toBe("?");
  });
});
