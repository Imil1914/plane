/**
 * Линия ADM (G2.2 R15a, 2026-09-29) · центр администратора PPM → «Пользователи»: «Отключить» / «Включить»
 * пользователя с подтверждением и состояния «Отключён» (отключён главным администратором PPM — вход в PPM и на
 * Git-сервер закрыт) и «Аккаунт деактивирован» (человек сам деактивировал учётную запись в Plane — центр её не
 * трогает). Целиком новый экран PPM без апстрим-аналога — простой словарь `ppmT`/`usePpmTranslation`, как `g22.*`
 * линии S4 и `admin.*`. Свои ключи — `g22.users.*`. Плейсхолдеры {name}/{date} подставляются простой заменой.
 * Подтверждение называет Git-сервер (`*_git`) только при включённом едином входе — иначе отключение его не касается
 * (ревью, раунд 1).
 */
export const G22_ADMIN_USERS_TRANSLATIONS = {
  en: {
    "g22.users.status_suspended": "Suspended",
    "g22.users.status_deactivated": "Account deactivated",
    "g22.users.suspended_since": "since {date}",
    "g22.users.suspend": "Suspend",
    "g22.users.resume": "Reactivate",
    "g22.users.confirm_suspend_title": "Suspend {name}?",
    "g22.users.confirm_suspend_description":
      "They will not be able to sign in to PPM; their open sessions end. Their project memberships stay — “Reactivate” brings access back.",
    "g22.users.confirm_suspend_description_git":
      "They will not be able to sign in to PPM or to the Git server; their open sessions end. Their project memberships stay — “Reactivate” brings access back.",
    "g22.users.confirm_resume_title": "Reactivate {name}?",
    "g22.users.confirm_resume_description": "They can sign in to PPM again and work in their projects.",
    "g22.users.confirm_resume_description_git":
      "They can sign in to PPM again; access to code on the Git server is restored automatically.",
    "g22.users.suspend_error": "Could not suspend the user.",
    "g22.users.resume_error": "Could not reactivate the user.",
  },
  ru: {
    "g22.users.status_suspended": "Отключён",
    "g22.users.status_deactivated": "Аккаунт деактивирован",
    "g22.users.suspended_since": "с {date}",
    "g22.users.suspend": "Отключить",
    "g22.users.resume": "Включить",
    "g22.users.confirm_suspend_title": "Отключить {name}?",
    "g22.users.confirm_suspend_description":
      "Он не сможет войти в PPM, открытые сеансы завершатся. Участие в проектах сохранится — «Включить» вернёт доступ.",
    "g22.users.confirm_suspend_description_git":
      "Он не сможет войти в PPM и на Git-сервер, открытые сеансы завершатся. Участие в проектах сохранится — «Включить» вернёт доступ.",
    "g22.users.confirm_resume_title": "Включить {name}?",
    "g22.users.confirm_resume_description": "Он снова сможет войти в PPM и работать в своих проектах.",
    "g22.users.confirm_resume_description_git":
      "Он снова сможет войти в PPM, доступ к коду на Git-сервере восстановится автоматически.",
    "g22.users.suspend_error": "Не удалось отключить пользователя.",
    "g22.users.resume_error": "Не удалось включить пользователя.",
  },
} as const;
