/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { i18n as I18nInstance } from "i18next";
import { i18nInstance } from "./instance";

/** Language → namespace → nested key tree that is merged over the loaded locale bundles. */
export type TTranslationOverlay = Record<string, Record<string, Record<string, unknown>>>;

/**
 * The i18next store API that the instance only proxies (and attaches late in init()).
 * The ResourceStore typings declare just on/off, so the used methods are typed here.
 */
type TBundleStore = I18nInstance["store"] & {
  hasResourceBundle(lng: string, ns: string): boolean;
  addResourceBundle(lng: string, ns: string, resources: unknown, deep: boolean, overwrite: boolean): void;
};

export function createTranslationOverlay(instance: I18nInstance) {
  let pending: TTranslationOverlay = {};
  let listening = false;
  let applying = false;

  // i18next creates the store only in init().
  const getStore = () => instance.store as TBundleStore | undefined;

  const applyLoaded = (store: TBundleStore, lng: string, ns: string) => {
    const bundle = pending[lng]?.[ns];
    // Never create a bundle before the base one loaded: i18next would then skip the backend load.
    if (!bundle || !store.hasResourceBundle(lng, ns)) return;
    applying = true;
    try {
      store.addResourceBundle(lng, ns, bundle, true, true);
    } finally {
      applying = false;
    }
    // i18next-icu memoizes compiled messages per key and does not drop them on store changes.
    (instance as unknown as { ICU?: { clearCache?: () => void } }).ICU?.clearCache?.();
  };

  const applyAllLoaded = (store: TBundleStore) => {
    for (const lng of Object.keys(pending)) for (const ns of Object.keys(pending[lng])) applyLoaded(store, lng, ns);
  };

  const listen = (store: TBundleStore) => {
    // "added" fires as soon as a base bundle lands in the store, before "languageChanged" re-renders the UI.
    store.on("added", (lng: string, ns: string) => {
      if (!applying) applyLoaded(store, lng, ns);
    });
    applyAllLoaded(store);
  };

  return {
    apply(overlay: TTranslationOverlay) {
      pending = overlay;
      const store = getStore();
      if (listening) {
        if (store) applyAllLoaded(store);
        return;
      }
      listening = true;
      if (store) listen(store);
      // Before init() a 3rdParty module is the hook that runs right after the store exists and before any load.
      else instance.use({ type: "3rdParty", init: () => listen(instance.store as TBundleStore) });
    },
  };
}

const defaultOverlay = createTranslationOverlay(i18nInstance);

export const applyTranslationOverlay = (overlay: TTranslationOverlay): void => defaultOverlay.apply(overlay);
