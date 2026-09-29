/**
 * G2.3 · линия G-Web (2026-09-29) · «Вставить коммит/PR» (диалог поиска Git-объектов проекта, вызывается кнопкой из
 * комментария задачи, описания задачи, страниц и заметки Хранилища, плюс пункт меню «/» на страницах) и «Что сделано
 * за период» (диалог пресетов периода с предпросмотром, страницы и заметки Хранилища). Оба — целиком новые экраны
 * PPM без апстрим-аналога в Plane, поэтому используется простой словарь `ppmT`/`usePpmTranslation` (как `g22.*`), а
 * не гейтинг `usePpmRu`/`ppmText`. Метки конкретных коммитов/PR (`label`) и готовый текст сводки (`markdown`/`html`)
 * приходят уже по-русски от API (контракт `docs/superpowers/plans/2026-09-29-g23-reports/plan.md`) — ключи `g23.*`
 * здесь только про элементы управления диалогов, не про текст внутри них.
 *
 * Два ключа — `ui.editor.git_object`/`ui.editor.slash_git_object` — исключение: их читает slash-пункт «/» внутри
 * `@plane/editor` через `editorText`/`resolvePpmEditorText` (тот же словарь, без второго), и они обязаны носить
 * префикс `ui.editor.*`/`ui.editor.slash_*`, единый для всех вызовов `editorText` в пакете (как `ui.editor.text`/
 * `ui.editor.slash_text`) — это проверяет apps/web/tests/ppm-shell/r2-editor-text.test.tsx, который сканирует
 * каждый `editorText(...)` во всём `packages/editor` и требует ровно этот префикс.
 */
export const G23_REPORTS_TRANSLATIONS = {
  en: {
    "g23.insert.button_label": "Insert commit/PR",
    "g23.insert.dialog_title": "Insert a commit or pull request",
    "g23.insert.search_placeholder": "Search by title, message, branch, SHA or number",
    "g23.insert.filter_all": "All",
    "g23.insert.filter_commit": "Commits",
    "g23.insert.filter_pull_request": "Pull requests",
    "g23.insert.empty_no_repositories": "No repositories are connected to this project — connect one in “Code”.",
    "g23.insert.empty_no_objects": "No commits or pull requests yet.",
    "g23.insert.empty_not_found": "Nothing found.",
    "g23.insert.loading": "Loading…",
    "g23.insert.retry": "Retry",
    "g23.insert.close": "Close",
    "g23.summary.button_label": "What's done for a period",
    "g23.summary.dialog_title": "What's done for a period",
    "g23.summary.preset_this_week": "This week",
    "g23.summary.preset_last_week": "Last week",
    "g23.summary.preset_two_weeks": "2 weeks",
    "g23.summary.preset_month": "Month",
    "g23.summary.preset_custom": "Custom dates",
    "g23.summary.from_label": "From",
    "g23.summary.to_label": "To",
    "g23.summary.preview_title": "Preview",
    "g23.summary.totals_done": "Done",
    "g23.summary.totals_in_progress": "In progress",
    "g23.summary.totals_other": "Other",
    "g23.summary.totals_commits": "Commits",
    "g23.summary.totals_pull_requests": "Pull requests",
    "g23.summary.empty": "No work items changed status with commits or PRs in this period.",
    "g23.summary.insert_action": "Insert",
    "g23.summary.loading": "Collecting the summary…",
    "g23.summary.retry": "Retry",
    "g23.summary.close": "Close",
    "ui.editor.git_object": "Commit or PR",
    "ui.editor.slash_git_object": "Insert a link to a commit or pull request",
  },
  ru: {
    "g23.insert.button_label": "Вставить коммит/PR",
    "g23.insert.dialog_title": "Вставить коммит или pull request",
    "g23.insert.search_placeholder": "Поиск по названию, сообщению, ветке, SHA или номеру",
    "g23.insert.filter_all": "Все",
    "g23.insert.filter_commit": "Коммиты",
    "g23.insert.filter_pull_request": "PR",
    "g23.insert.empty_no_repositories": "К проекту не подключены репозитории — подключите в разделе «Код».",
    "g23.insert.empty_no_objects": "Коммитов и PR пока нет.",
    "g23.insert.empty_not_found": "Ничего не найдено.",
    "g23.insert.loading": "Загружаем…",
    "g23.insert.retry": "Повторить",
    "g23.insert.close": "Закрыть",
    "g23.summary.button_label": "Что сделано за период",
    "g23.summary.dialog_title": "Что сделано за период",
    "g23.summary.preset_this_week": "Эта неделя",
    "g23.summary.preset_last_week": "Прошлая неделя",
    "g23.summary.preset_two_weeks": "2 недели",
    "g23.summary.preset_month": "Месяц",
    "g23.summary.preset_custom": "Свои даты",
    "g23.summary.from_label": "С",
    "g23.summary.to_label": "По",
    "g23.summary.preview_title": "Предпросмотр",
    "g23.summary.totals_done": "Сделано",
    "g23.summary.totals_in_progress": "В работе",
    "g23.summary.totals_other": "Прочее",
    "g23.summary.totals_commits": "Коммитов",
    "g23.summary.totals_pull_requests": "PR",
    "g23.summary.empty": "За этот период нет задач со сменой статуса, коммитов или PR.",
    "g23.summary.insert_action": "Вставить",
    "g23.summary.loading": "Собираем сводку…",
    "g23.summary.retry": "Повторить",
    "g23.summary.close": "Закрыть",
    "ui.editor.git_object": "Коммит или PR",
    "ui.editor.slash_git_object": "Вставить ссылку на коммит или pull request",
  },
} as const;
