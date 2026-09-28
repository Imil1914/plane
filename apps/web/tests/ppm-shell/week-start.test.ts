/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R: the calendars of the Russian interface start on Monday. Plane stores Sunday for every profile by default,
// so the stored default is read as Monday until the user picks a day themselves (then their choice wins).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EStartOfTheWeek } from "@plane/types";
import type { TUserProfile } from "@plane/types";
import { resolvePpmStartOfWeek } from "@/components/ppm-shell/week-start";
import { ProfileStore } from "@/store/user/profile.store";
import type { CoreRootStore } from "@/store/root.store";

const api = vi.hoisted(() => ({
  profile: undefined as unknown,
  update: vi.fn(async (data: unknown) => data),
}));
vi.mock("@/services/user.service", () => ({
  UserService: class {
    getCurrentUserProfile = async () => api.profile;
    updateCurrentUserProfile = (data: unknown) => api.update(data);
  },
}));
vi.mock("@plane/i18n", () => ({ LANGUAGE_STORAGE_KEY: "userLanguage", setLanguage: async () => undefined }));

const ru = { shellEnabled: true, language: "ru", explicit: false };

describe("first day of the week (line R)", () => {
  it("starts the Russian PPM week on Monday while the profile keeps Plane's default Sunday", () => {
    expect(resolvePpmStartOfWeek(EStartOfTheWeek.SUNDAY, ru)).toBe(EStartOfTheWeek.MONDAY);
    expect(resolvePpmStartOfWeek(undefined, ru)).toBe(EStartOfTheWeek.MONDAY);
  });

  it("keeps any other stored day and an explicit Sunday", () => {
    expect(resolvePpmStartOfWeek(EStartOfTheWeek.SATURDAY, ru)).toBe(EStartOfTheWeek.SATURDAY);
    expect(resolvePpmStartOfWeek(EStartOfTheWeek.SUNDAY, { ...ru, explicit: true })).toBe(EStartOfTheWeek.SUNDAY);
  });

  it("leaves the English interface and PPM_SHELL_ENABLED=0 exactly as stored", () => {
    expect(resolvePpmStartOfWeek(EStartOfTheWeek.SUNDAY, { ...ru, language: "en" })).toBe(EStartOfTheWeek.SUNDAY);
    expect(resolvePpmStartOfWeek(EStartOfTheWeek.SUNDAY, { ...ru, shellEnabled: false })).toBe(EStartOfTheWeek.SUNDAY);
    expect(resolvePpmStartOfWeek(undefined, { ...ru, language: undefined })).toBe(EStartOfTheWeek.SUNDAY);
  });
});

describe("ProfileStore.startOfTheWeek with the explicit choice (line R, fix round 1)", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    };
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });
    api.update.mockReset();
    api.update.mockImplementation(async (data: unknown) => data);
  });
  afterEach(() => vi.unstubAllGlobals());

  // A sign-in (or a sign-out and the next sign-in) creates a fresh store and loads that user's profile.
  async function signIn(user: string, language = "ru") {
    api.profile = { user, language, is_onboarded: true, start_of_the_week: EStartOfTheWeek.SUNDAY };
    const store = new ProfileStore({} as CoreRootStore);
    await store.fetchUserProfile();
    return store;
  }
  const saveSunday = (store: ProfileStore) =>
    store.updateUserProfile({ start_of_the_week: EStartOfTheWeek.SUNDAY } as Partial<TUserProfile>);
  const explicitKeys = () => [...storage.keys()].filter((key) => key.startsWith("ppm_week_start_explicit"));

  it("reads Plane's stored default Sunday as Monday in the Russian interface", async () => {
    expect((await signIn("u1")).startOfTheWeek).toBe(EStartOfTheWeek.MONDAY);
  });

  it("keeps a Sunday the profile saved — for this user only, also after the next sign-in", async () => {
    const store = await signIn("u1");
    await saveSunday(store);
    expect(api.update).toHaveBeenCalledWith({ start_of_the_week: EStartOfTheWeek.SUNDAY });
    expect(store.startOfTheWeek).toBe(EStartOfTheWeek.SUNDAY);
    expect(explicitKeys()).toEqual(["ppm_week_start_explicit:u1"]);
    // Another account on the same browser starts with the Russian default again …
    expect((await signIn("u2")).startOfTheWeek).toBe(EStartOfTheWeek.MONDAY);
    // … and the first one keeps its choice.
    expect((await signIn("u1")).startOfTheWeek).toBe(EStartOfTheWeek.SUNDAY);
  });

  it("does not count a choice the server rejected", async () => {
    const store = await signIn("u1");
    api.update.mockRejectedValueOnce(new Error("offline"));
    await saveSunday(store);
    expect(store.startOfTheWeek).toBe(EStartOfTheWeek.MONDAY);
    expect(explicitKeys()).toEqual([]);
  });

  it("leaves the English interface as stored", async () => {
    expect((await signIn("u1", "en")).startOfTheWeek).toBe(EStartOfTheWeek.SUNDAY);
  });
});
