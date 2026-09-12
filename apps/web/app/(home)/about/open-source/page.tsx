/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Link from "next/link";
import { PLANE_SOURCE_ATTRIBUTION, PPM_BRAND } from "@ppm/brand";
import type { Route } from "./+types/page";

export const meta: Route.MetaFunction = () => [
  { title: `Открытый код — ${PPM_BRAND.name}` },
  {
    name: "description",
    content: "Сведения об открытом исходном коде, лицензии и базовой версии Plane Community в PPM.",
  },
];

export default function OpenSourcePage() {
  const sourceUrl = `${PLANE_SOURCE_ATTRIBUTION.forkRepository}/tree/${PLANE_SOURCE_ATTRIBUTION.baselineCommit}`;

  return (
    <div className="min-h-screen overflow-y-auto bg-canvas px-6 py-10 text-primary sm:px-10">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between gap-6">
          <Link href="/" aria-label="На главную PPM">
            <img alt={PPM_BRAND.name} className="h-10 w-auto" height={40} src={PPM_BRAND.assets.logo} />
          </Link>
          <Link className="text-body-sm-medium text-link-primary hover:text-link-primary-hover" href="/">
            Вернуться в приложение
          </Link>
        </header>

        <section className="rounded-xl border border-subtle-1 bg-surface-1 p-6 shadow-raised-100 sm:p-8">
          <p className="tracking-widest mb-3 text-caption-md-semibold text-accent-primary uppercase">Открытый код</p>
          <h1 className="text-3xl font-semibold tracking-tight">Основа PPM остаётся проверяемой</h1>
          <p className="mt-4 max-w-2xl text-body-md-regular text-tertiary">
            PPM использует {PLANE_SOURCE_ATTRIBUTION.component} как базовый движок управления проектами и сохраняет его
            лицензию, историю происхождения и доступ к соответствующему исходному коду.
          </p>

          <dl className="mt-8 grid gap-5 border-t border-subtle pt-6 sm:grid-cols-2">
            <SourceItem label="Базовая версия" value={PLANE_SOURCE_ATTRIBUTION.releaseTag} />
            <SourceItem label="Лицензия" value={PLANE_SOURCE_ATTRIBUTION.license} />
            <SourceItem label="Компонент" value={PLANE_SOURCE_ATTRIBUTION.component} />
            <SourceItem label="Baseline commit" value={PLANE_SOURCE_ATTRIBUTION.baselineCommit.slice(0, 12)} mono />
          </dl>

          <div className="mt-8 flex flex-wrap gap-3">
            <SourceLink href={sourceUrl}>Исходный код PPM-форка</SourceLink>
            <SourceLink href={PLANE_SOURCE_ATTRIBUTION.upstreamRepository}>Оригинальный Plane</SourceLink>
          </div>
        </section>

        <section className="rounded-xl border border-subtle-1 bg-surface-2 p-6">
          <h2 className="text-h4-semibold">Как воспроизвести основу</h2>
          <p className="mt-2 text-body-sm-regular text-tertiary">
            Зафиксированный тег, commit и контрольные суммы хранятся в manifest интеграции PPM. Инструкции запуска и
            проверки находятся рядом с исходным кодом проекта.
          </p>
          <Link
            className="mt-4 inline-flex text-body-sm-semibold text-link-primary hover:text-link-primary-hover"
            href="/about/brand-foundation"
          >
            Проверить бренд-компоненты →
          </Link>
        </section>
      </main>
    </div>
  );
}

function SourceItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-caption-md-medium text-tertiary">{label}</dt>
      <dd className={`mt-1 text-body-sm-semibold ${mono ? "font-code" : ""}`}>{value}</dd>
    </div>
  );
}

function SourceLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <a
      className="inline-flex h-8 items-center rounded-md border border-strong bg-layer-2 px-3 text-body-sm-semibold text-secondary hover:bg-layer-2-hover"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}
