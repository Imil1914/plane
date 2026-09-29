/**
 * Линия S4 (G2.2, 2026-09-29) · web-часть единого входа через PPM: раздел «Код» (подсказка о недостающей учётке на
 * Git-сервере со ссылкой на вход, имя пользователя и подсказка про токен, подсказка «войдите» без учётки) и вкладка
 * «Git-сервер» центра администратора PPM. Механизм — как у линий R/R2 (`packages/ppm-brand`), но без их
 * shell-гейтинга (`usePpmRu`/`ppmText`): это целиком новый экран PPM, а не перевод существующего англоязычного —
 * поэтому используется простой словарь `ppmT`/`usePpmTranslation` (как ключи `admin.*`/`code.*`), который просто
 * показывает текст на языке интерфейса (`currentLocale`), в обоих языках и вне зависимости от `PPM_SHELL_ENABLED`.
 * Свои ключи — `g22.*`: `g22.code.*` («Код»), `g22.admin.*` (центр администратора → «Git-сервер»). en — нейтральный
 * английский текст того же смысла (нет прежнего литерала для перевода — это новый текст).
 * Плейсхолдеры {name} подставляются простой заменой (`String.prototype.replace`), без ICU.
 */
export const G22_SSO_TRANSLATIONS = {
  en: {
    // «Код» (R17/R21): a project administrator connects a repository of our Git server; without a personal account
    // there yet, the picker shows this instead of the repository list.
    "g22.code.connect_account_required_title": "Sign in to the Git server first",
    "g22.code.connect_account_required_description":
      "Sign in to the Git server with the “Sign in with PPM” button first — your repositories will appear here.",
    "g22.code.connect_account_required_action": "Sign in with PPM",
    // «Как скачать код» (R21): the viewer's own username on our Git server, and the HTTPS token hint — shown only
    // for a repository of our Git server while single sign-on is configured.
    "g22.code.your_git_username": "Your username on the Git server: {username}",
    "g22.code.https_token_hint": "HTTPS needs a token: Git server → Settings → Applications.",
    "g22.code.sign_in_hint": "Sign in to the Git server with the “Sign in with PPM” button.",
    // Центр администратора → «Git-сервер» (R18/R19).
    "g22.admin.git_tab": "Git server",
    "g22.admin.git_description": "Single sign-on and automatic access to the repositories of our Git server.",
    "g22.admin.git_configured": "Configured",
    "g22.admin.git_not_configured": "Not configured",
    "g22.admin.git_reachable": "Reachable",
    "g22.admin.git_unreachable": "Not responding",
    "g22.admin.git_sso_on": "Single sign-on is on",
    "g22.admin.git_sso_off": "Single sign-on is off",
    "g22.admin.git_last_sync_title": "Last full reconciliation",
    "g22.admin.git_last_sync_never": "Has not run yet",
    "g22.admin.git_sync_status_ok": "Succeeded",
    "g22.admin.git_sync_status_partial": "Partly succeeded",
    "g22.admin.git_sync_status_error": "Failed",
    "g22.admin.git_sync_duration_seconds": "{seconds} s",
    "g22.admin.git_sync_now": "Sync now",
    "g22.admin.git_sync_scheduled": "The sync has been queued.",
    "g22.admin.git_sync_retry_after": "You can try again in {seconds} s.",
    "g22.admin.git_sync_error": "Could not start the sync.",
    "g22.admin.git_problems_title": "Recent problems",
    "g22.admin.git_no_problems": "No problems.",
    "g22.admin.git_open_admin": "Open Git server administration",
    "g22.admin.git_counts_accounts": "Accounts",
    "g22.admin.git_counts_organizations": "Organizations",
    "g22.admin.git_counts_teams": "Teams",
    "g22.admin.git_counts_repositories": "Repositories",
    "g22.admin.git_counts_changes": "Changes",
    "g22.admin.git_error": "The Git server status could not be loaded.",
    "g22.admin.git_retry": "Retry",
    // Round 1 (#6): a problem's `kind`, in the interface language — no raw code, no raw id in the row's title.
    "g22.admin.git_problem_kind_account": "Account",
    "g22.admin.git_problem_kind_organization": "Organization",
    "g22.admin.git_problem_kind_project": "Project",
    "g22.admin.git_problem_kind_team": "Team",
    // Round 2 (Minor D-3): was missing.
    "g22.admin.git_problem_kind_repository": "Repository",
    "g22.admin.git_problem_kind_forgejo": "Git server",
    "g22.admin.git_problem_kind_ppm": "PPM",
  },
  ru: {
    "g22.code.connect_account_required_title": "Сначала войдите на Git-сервер",
    "g22.code.connect_account_required_description":
      "Сначала войдите на Git-сервер кнопкой «Войти через PPM» — здесь появятся ваши репозитории.",
    "g22.code.connect_account_required_action": "Войти через PPM",
    "g22.code.your_git_username": "Ваше имя на Git-сервере: {username}",
    "g22.code.https_token_hint": "Для HTTPS нужен токен: Git-сервер → Настройки → Приложения.",
    "g22.code.sign_in_hint": "Войдите на Git-сервер кнопкой «Войти через PPM».",
    "g22.admin.git_tab": "Git-сервер",
    "g22.admin.git_description": "Единый вход и автоматические доступы к репозиториям нашего Git-сервера.",
    "g22.admin.git_configured": "Настроен",
    "g22.admin.git_not_configured": "Не настроен",
    "g22.admin.git_reachable": "Отвечает",
    "g22.admin.git_unreachable": "Не отвечает",
    "g22.admin.git_sso_on": "Единый вход включён",
    "g22.admin.git_sso_off": "Единый вход выключен",
    "g22.admin.git_last_sync_title": "Последняя полная сверка",
    "g22.admin.git_last_sync_never": "Ещё не выполнялась",
    "g22.admin.git_sync_status_ok": "Успешно",
    "g22.admin.git_sync_status_partial": "Частично",
    "g22.admin.git_sync_status_error": "Ошибка",
    "g22.admin.git_sync_duration_seconds": "{seconds} с",
    "g22.admin.git_sync_now": "Синхронизировать сейчас",
    "g22.admin.git_sync_scheduled": "Синхронизация поставлена в очередь.",
    "g22.admin.git_sync_retry_after": "Можно повторить через {seconds} с.",
    "g22.admin.git_sync_error": "Не удалось запустить синхронизацию.",
    "g22.admin.git_problems_title": "Последние проблемы",
    "g22.admin.git_no_problems": "Проблем нет.",
    "g22.admin.git_open_admin": "Открыть администрирование Git-сервера",
    "g22.admin.git_counts_accounts": "Учётки",
    "g22.admin.git_counts_organizations": "Организации",
    "g22.admin.git_counts_teams": "Команды",
    "g22.admin.git_counts_repositories": "Репозитории",
    "g22.admin.git_counts_changes": "Изменения",
    "g22.admin.git_error": "Не удалось загрузить статус Git-сервера.",
    "g22.admin.git_retry": "Повторить",
    "g22.admin.git_problem_kind_account": "Учётка",
    "g22.admin.git_problem_kind_organization": "Организация",
    "g22.admin.git_problem_kind_project": "Проект",
    "g22.admin.git_problem_kind_team": "Команда",
    "g22.admin.git_problem_kind_repository": "Репозиторий",
    "g22.admin.git_problem_kind_forgejo": "Git-сервер",
    "g22.admin.git_problem_kind_ppm": "PPM",
  },
} as const;
