/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import { getPpmTranslation, PPM_BRAND, PPM_SOURCE_ATTRIBUTION } from "@ppm/brand";
import type { Route } from "./+types/page";

export const meta: Route.MetaFunction = () => [
  { title: `О программе — ${PPM_BRAND.name}` },
  {
    name: "description",
    content: "Версия, сборка, лицензия и исходный код PPM.",
  },
];

export default function OpenSourcePage() {
  const { currentLocale } = useTranslation();
  const ppmT = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation(currentLocale, key);
  const isRussian = currentLocale?.toLowerCase().startsWith("ru");
  const sourceRevision = process.env.VITE_PPM_SOURCE_REVISION || (isRussian ? "локальная сборка" : "local build");
  const release = process.env.VITE_PPM_RELEASE || (isRussian ? "локальная сборка" : "local build");
  const buildDate = process.env.VITE_PPM_BUILD_DATE || (isRussian ? "не указана" : "not recorded");
  const hasExactRevision = /^[0-9a-f]{40}$/i.test(sourceRevision);
  const sourceUrl = hasExactRevision
    ? `${PPM_SOURCE_ATTRIBUTION.repository}/tree/${sourceRevision}`
    : PPM_SOURCE_ATTRIBUTION.repository;

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
          <p className="mb-3 text-caption-md-semibold tracking-[0.12em] text-accent-primary uppercase">
            {ppmT("about.eyebrow")}
          </p>
          <h1 className="text-28 font-semibold tracking-tight">{ppmT("about.heading")}</h1>
          <p className="mt-4 max-w-2xl text-body-md-regular text-tertiary">{ppmT("about.description")}</p>

          <dl className="mt-8 grid gap-5 border-t border-subtle pt-6 sm:grid-cols-2">
            <SourceItem label={ppmT("about.version")} value={PPM_SOURCE_ATTRIBUTION.version} />
            <SourceItem label={ppmT("about.release")} value={release} />
            <SourceItem label={ppmT("about.build_date")} value={buildDate} />
            <SourceItem label={ppmT("about.license")} value={PPM_SOURCE_ATTRIBUTION.license} />
            <SourceItem label={ppmT("about.source_revision")} value={sourceRevision} mono={hasExactRevision} />
          </dl>

          <div className="mt-8 flex flex-wrap gap-3">
            <SourceLink href={sourceUrl}>{ppmT("about.source_code")}</SourceLink>
          </div>
        </section>

        <section className="rounded-xl border border-subtle-1 bg-surface-2 p-6">
          <h2 className="text-h4-semibold">{ppmT("about.open_title")}</h2>
          <p className="mt-2 text-body-sm-regular text-tertiary">{ppmT("about.open_description")}</p>
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
