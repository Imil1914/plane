# PPM brand surface inventory

Дата среза: 2026-09-12

Baseline: Plane Community `v1.4.2` / `5f7d92784c403f76284f0f16718f320221dc7fec`

Этот документ фиксирует брендовые entrypoint-ы pinned Plane source. Он не требует удалить каждое упоминание Plane в I0.2: юридические ссылки на upstream сохраняются, а хвостовые продуктовые поверхности переходят в I0.3 и последующие задачи.

## Подключено в I0.2

| Surface                              | Source                                                                                             | Реализация                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Root title, description, social meta | `apps/web/app/root.tsx`                                                                            | PPM при включённом флаге, исходный Plane при выключенном                       |
| Favicon, Apple icon, PWA manifest    | `apps/web/app/root.tsx`, `apps/web/public/ppm-brand/`, `apps/web/public/site.ppm.webmanifest.json` | Изолированные PPM assets; baseline assets не удалены                           |
| Theme and component tokens           | `packages/ppm-brand/src/tokens.css`                                                                | Graphite/Light + bridge к Plane/Propel semantic variables                      |
| Typography                           | `apps/web/app/root.tsx`, `packages/ppm-brand/src/tokens.css`                                       | Local-hosted IBM Plex Sans Variable и JetBrains Mono Variable                  |
| Sign-in lockup and page title        | `apps/web/core/components/auth-screens/header.tsx`                                                 | PPM logo/name под тем же флагом                                                |
| Sign-in footer copy                  | `apps/web/core/components/auth-screens/footer.tsx`                                                 | PPM copy под тем же флагом                                                     |
| License and source disclosure        | `apps/web/app/(home)/about/open-source/page.tsx`                                                   | Версия, tag, commit, AGPL, fork и upstream из `@ppm/brand/build-manifest.json` |
| Representative component smoke       | `apps/web/app/(home)/about/brand-foundation/page.tsx`                                              | Button, Input, Dialog и Toast в Light/Graphite                                 |

## Сохранено как upstream attribution

- package names `@plane/*` и импорты Plane/Propel;
- copyright и SPDX headers;
- название `Plane Community` на странице открытого кода;
- upstream/fork URLs, release tag и baseline commit;
- исходные favicon/manifest/meta, необходимые для rollback через `PPM_BRAND_ENABLED=0`.

## Отложено после I0.2

| Категория                  | Найденные entrypoint-ы                                                                                                 | Следующее действие                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Onboarding                 | `apps/web/core/components/onboarding/header.tsx`, `apps/web/core/components/onboarding/tour/root.tsx`                  | I0.3 shell/UX pass                                             |
| Workspace fallback         | `apps/web/core/layouts/auth-layout/workspace-wrapper.tsx`                                                              | I0.3 shell/UX pass                                             |
| Create/invite screens      | `apps/web/app/(all)/create-workspace/page.tsx`, `apps/web/app/(all)/invitations/page.tsx`                              | I0.3 auth/workspace pass                                       |
| Instance/error states      | `apps/web/core/components/instance/not-ready-view.tsx`, `apps/web/app/error/prod.tsx`                                  | self-hosted deployment pass                                    |
| Product updates/help links | `apps/web/core/components/global/product-updates/`, `apps/web/core/components/workspace/sidebar/help-section/root.tsx` | support/content policy decision                                |
| Legacy metadata entrypoint | `apps/web/app/layout.tsx`, `apps/web/manifest.json`                                                                    | подтвердить отсутствие runtime usage перед удалением/переносом |
| Plane business semantics   | activity strings, intake service address, docs links                                                                   | сохранять, пока не появится PPM-эквивалент                     |

По целевому grep найдено 28 файлов с явными `PlaneLogo`, `PlaneLockup`, title или manifest surface. В I0.2 меняются только entrypoint-ы, необходимые для foundation и обратимого первого пользовательского впечатления.

## Evidence

- visual snapshot: `docs/ppm/artifacts/i0.2-brand-foundation.png`;
- token/flag tests: `packages/ppm-brand/src/__tests__/brand.test.ts`;
- rollback: production build с `PPM_BRAND_ENABLED=0` возвращает Plane title, favicon manifests и `data-ppm-brand="disabled"`;
- основной build manifest: `packages/ppm-brand/build-manifest.json`.
