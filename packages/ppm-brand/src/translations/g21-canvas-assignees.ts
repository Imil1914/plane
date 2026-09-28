/**
 * G2.1 · линия C (2026-09-28) · исполнители задачи на Холсте: аватарки (до 3 + «+N») и выпадающий выбор с флажками —
 * в живой карточке, в карточке вида задач и в инспекторе. Только новые ключи `canvas.assignees_*`; пустое значение —
 * прежний `canvas.unassigned` («Не назначен», как в Задачах). Плейсхолдер {names} подставляет fillCanvasTemplate.
 */
export const G21_CANVAS_ASSIGNEES_TRANSLATIONS = {
  en: {
    "canvas.assignees_summary": "Assignees: {names}",
    "canvas.assignees_summary_none": "Assignees: none",
    "canvas.assignees_more": "More: {names}",
    "canvas.assignees_search": "Find a member",
    "canvas.assignees_clear": "Clear all",
    "canvas.assignees_empty": "No project members yet",
    "canvas.assignees_no_matches": "No one found",
    "canvas.assignees_saving": "Saving…",
  },
  ru: {
    "canvas.assignees_summary": "Исполнители: {names}",
    "canvas.assignees_summary_none": "Исполнители: не назначен",
    "canvas.assignees_more": "Ещё: {names}",
    "canvas.assignees_search": "Найти участника",
    "canvas.assignees_clear": "Снять всех",
    "canvas.assignees_empty": "В проекте пока нет участников",
    "canvas.assignees_no_matches": "Никого не нашли",
    "canvas.assignees_saving": "Сохраняем…",
  },
} as const;
