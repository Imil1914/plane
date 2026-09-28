/**
 * Линия S (2026-09-28) · цифры и графики спринтов и направлений: тексты панели активного спринта, боковой аналитики
 * спринта и направления и общих строк статистики («0% из 1»). Только новые ключи `stats.*`; en = прежний английский
 * текст (он же остаётся в компоненте веткой без оболочки PPM). Плейсхолдер {total} подставляет компонент.
 * Словарь PPM: «задача», «спринт», «направление» — не «рабочий элемент», «цикл», «модуль».
 */
export const S_LIVE_STATS_TRANSLATIONS = {
  en: {
    "stats.of_total": "of {total}",
    "stats.no_work_items": "0 work items",
    "stats.tooltip_title": "Title",
    "stats.tooltip_due_date": "Target Date",
    "stats.no_label": "No labels",
    "stats.toast_success": "Success!",
    "stats.toast_error": "Error!",
    "stats.something_went_wrong": "Some error occurred",
    "stats.module_link_deleted": "Module link deleted successfully.",
    "stats.module_updated": "Module updated successfully.",
  },
  ru: {
    "stats.of_total": "из {total}",
    "stats.no_work_items": "0 задач",
    "stats.tooltip_title": "Название",
    "stats.tooltip_due_date": "Срок",
    "stats.no_label": "Без метки",
    "stats.toast_success": "Готово",
    "stats.toast_error": "Ошибка",
    "stats.something_went_wrong": "Что-то пошло не так",
    "stats.module_link_deleted": "Ссылка направления удалена.",
    "stats.module_updated": "Направление обновлено.",
  },
} as const;
