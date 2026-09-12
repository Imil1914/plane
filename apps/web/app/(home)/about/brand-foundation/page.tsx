/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@plane/propel/button";
import { Dialog } from "@plane/propel/dialog";
import { Input } from "@plane/propel/input";
import { ToastStatic, TOAST_TYPE } from "@plane/propel/toast";
import { PPM_BRAND } from "@ppm/brand";
import type { Route } from "./+types/page";

export const meta: Route.MetaFunction = () => [{ title: `Проверка бренд-фундамента — ${PPM_BRAND.name}` }];

export default function BrandFoundationPage() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="min-h-screen overflow-y-auto bg-canvas px-6 py-10 text-primary sm:px-10">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="tracking-widest text-caption-md-semibold text-accent-primary uppercase">I0.2 smoke</p>
            <h1 className="text-3xl mt-2 font-semibold tracking-tight">PPM brand foundation</h1>
            <p className="mt-2 text-body-sm-regular text-tertiary">
              Реальные Button, Input, Dialog и Toast из Propel на едином наборе семантических токенов.
            </p>
          </div>
          <Link
            className="text-body-sm-semibold text-link-primary hover:text-link-primary-hover"
            href="/about/open-source"
          >
            Открытый код
          </Link>
        </header>

        <div className="grid gap-5 lg:grid-cols-2">
          <ThemeSmoke theme="light" title="Light" onOpenDialog={() => setDialogOpen(true)} />
          <ThemeSmoke theme="dark" title="Graphite" onOpenDialog={() => setDialogOpen(true)} />
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Panel>
            <div className="p-6">
              <Dialog.Title>PPM Dialog</Dialog.Title>
              <p className="mt-3 text-body-sm-regular text-tertiary">
                Диалог использует те же surface, border, text и focus tokens, что и остальной интерфейс.
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                  Закрыть
                </Button>
                <Button onClick={() => setDialogOpen(false)}>Готово</Button>
              </div>
            </div>
          </Dialog.Panel>
        </Dialog>
      </main>
    </div>
  );
}

function ThemeSmoke({
  onOpenDialog,
  theme,
  title,
}: {
  onOpenDialog: () => void;
  theme: "light" | "dark";
  title: string;
}) {
  return (
    <section
      data-theme={theme}
      className="rounded-xl border border-subtle-1 bg-surface-1 p-6 text-primary shadow-raised-100"
    >
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-h4-semibold">{title}</h2>
          <p className="mt-1 text-body-sm-regular text-tertiary">Тема {theme === "dark" ? "Graphite" : "Light"}</p>
        </div>
        <span className="size-5 rounded-full bg-accent-primary shadow-raised-100" title="#22D3EE" />
      </div>

      <div className="grid gap-3">
        <label className="grid gap-1.5 text-body-xs-medium text-secondary">
          Название проекта
          <Input aria-label={`Название проекта, тема ${title}`} defaultValue="Новый проект" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button>Создать</Button>
          <Button variant="secondary" onClick={onOpenDialog}>
            Открыть Dialog
          </Button>
          <Button variant="ghost">Позже</Button>
        </div>
        <div className="mt-2 overflow-x-auto">
          <ToastStatic
            message="Семантические цвета читаются и не зависят от hex в компоненте."
            theme={theme}
            title="PPM Toast"
            type={TOAST_TYPE.INFO}
          />
        </div>
      </div>
    </section>
  );
}
