/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Link from "next/link";
import { PPM_BRAND, PPM_SOURCE_ATTRIBUTION } from "@ppm/brand";
import type { Route } from "./+types/page";

export const meta: Route.MetaFunction = () => [
  { title: `Руководство — ${PPM_BRAND.name}` },
  { name: "description", content: "Краткое руководство по основным разделам и ролям PPM." },
];

const GUIDE_SECTIONS = [
  {
    title: "Проекты и роли",
    description:
      "Главный администратор видит все проекты. Руководитель проекта и участники видят только проекты, в которые они добавлены.",
  },
  {
    title: "Холст",
    description:
      "Открывайте холст кнопкой рядом с проектом. На нём можно размещать заметки, задачи, материалы и смысловые связи.",
  },
  {
    title: "Работа",
    description:
      "В разделе задач находятся рабочие элементы проекта, фильтры задач и спринты. Изменения синхронизируются с проектом.",
  },
  {
    title: "Хранилище и документы",
    description:
      "Хранилище содержит Markdown, PDF и другие материалы проекта. Документы предназначены для совместной работы команды.",
  },
] as const;

export default function PpmGuidePage() {
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
          <p className="tracking-widest text-caption-md-semibold text-accent-primary uppercase">Помощь</p>
          <h1 className="text-3xl mt-3 font-semibold tracking-tight">Руководство PPM</h1>
          <p className="mt-3 text-body-md-regular text-tertiary">
            Краткая карта основных возможностей системы управления проектами.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {GUIDE_SECTIONS.map((section) => (
              <article key={section.title} className="rounded-lg border border-subtle bg-surface-2 p-5">
                <h2 className="text-h5-semibold">{section.title}</h2>
                <p className="mt-2 text-body-sm-regular text-tertiary">{section.description}</p>
              </article>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-subtle pt-6">
            <Link
              className="inline-flex h-9 items-center rounded-md bg-accent-primary px-4 text-body-sm-semibold text-on-color hover:bg-accent-primary-hover"
              href="/"
            >
              Открыть PPM
            </Link>
            <a
              className="text-body-sm-semibold text-link-primary hover:text-link-primary-hover"
              href={`${PPM_SOURCE_ATTRIBUTION.repository}/issues/new`}
              rel="noreferrer"
              target="_blank"
            >
              Сообщить о проблеме
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
