/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Usage (from packages/i18n):
//   tsx scripts/check-overlay.ts     # Exit 1 if the translation overlay misbehaves on a real i18next instance

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createInstance } from "i18next";
import type ICUPlugin from "i18next-icu";
import resourcesToBackend from "i18next-resources-to-backend";
import { createTranslationOverlay } from "../src/core/overlay";

// The ESM build of i18next-icu default-imports the CommonJS intl-messageformat, which only resolves in bundlers:
// under plain Node every ICU message silently falls back to its raw source. The CommonJS build formats correctly.
const ICU = (createRequire(import.meta.url)("i18next-icu") as { default: typeof ICUPlugin }).default;

const base = {
  ru: { common: { a: "рабочий элемент", b: "Оставить", n: "{count, plural, one {# элемент} other {# элементов}}" } },
};
async function fresh() {
  const inst = createInstance();
  inst.use(ICU).use(
    resourcesToBackend(async (lng: string, ns: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return (base as any)[lng]?.[ns] ?? {};
    })
  );
  await inst.init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["common"],
    defaultNS: "common",
    partialBundledLanguages: true,
    nsSeparator: false,
    interpolation: { escapeValue: false },
  });
  return inst;
}
// (1) overlay registered BEFORE the base bundle loads must not block the base load
{
  const inst = createInstance();
  inst.use(ICU).use(
    resourcesToBackend(async (lng: string, ns: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return (base as any)[lng]?.[ns] ?? {};
    })
  );
  createTranslationOverlay(inst).apply({ ru: { common: { a: "задача" } } });
  await inst.init({
    lng: "ru",
    fallbackLng: "ru",
    ns: ["common"],
    defaultNS: "common",
    partialBundledLanguages: true,
    nsSeparator: false,
    interpolation: { escapeValue: false },
  });
  assert.equal(inst.t("a"), "задача");
  assert.equal(inst.t("b"), "Оставить", "base keys must survive");
}
// (2) overlay applied AFTER load replaces the value and clears ICU cache
{
  const inst = await fresh();
  assert.equal(inst.t("n", { count: 5 }), "5 элементов");
  createTranslationOverlay(inst).apply({
    ru: { common: { n: "{count, plural, one {# задача} few {# задачи} many {# задач} other {# задачи}}" } },
  });
  assert.equal(inst.t("n", { count: 5 }), "5 задач");
  assert.equal(inst.t("b"), "Оставить", "untouched keys stay");
}
console.log("overlay check: OK");
