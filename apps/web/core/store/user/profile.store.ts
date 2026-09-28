/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { cloneDeep, set } from "lodash-es";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
// plane imports
import { LANGUAGE_STORAGE_KEY, setLanguage } from "@plane/i18n";
import type { TLanguage } from "@plane/i18n";
import { isPpmShellEnabled, PPM_DEFAULT_LANGUAGE, shouldInitializePpmProfileLanguage } from "@ppm/brand";
// types
import type { IUserTheme, TUserProfile } from "@plane/types";
import { EStartOfTheWeek } from "@plane/types";
// components
import {
  markPpmWeekStartExplicit,
  readPpmWeekStartExplicit,
  resolvePpmStartOfWeek,
} from "@/components/ppm-shell/week-start";
// services
import { UserService } from "@/services/user.service";
// store
import type { CoreRootStore } from "../root.store";

type TError = {
  status: string;
  message: string;
};

export interface IUserProfileStore {
  // observables
  isLoading: boolean;
  error: TError | undefined;
  data: TUserProfile;
  // computed
  startOfTheWeek: EStartOfTheWeek;
  // actions
  fetchUserProfile: () => Promise<TUserProfile | undefined>;
  updateUserProfile: (data: Partial<TUserProfile>) => Promise<TUserProfile | undefined>;
  finishUserOnboarding: () => Promise<void>;
  updateTourCompleted: () => Promise<TUserProfile | undefined>;
  updateUserTheme: (data: Partial<IUserTheme>) => Promise<TUserProfile | undefined>;
}

export class ProfileStore implements IUserProfileStore {
  isLoading: boolean = false;
  error: TError | undefined = undefined;
  data: TUserProfile = {
    id: undefined,
    user: undefined,
    role: undefined,
    last_workspace_id: undefined,
    theme: {
      theme: undefined,
      primary: undefined,
      background: undefined,
      darkPalette: false,
    },
    onboarding_step: {
      workspace_join: false,
      profile_complete: false,
      workspace_create: false,
      workspace_invite: false,
    },
    is_onboarded: false,
    is_tour_completed: false,
    use_case: undefined,
    billing_address_country: undefined,
    billing_address: undefined,
    has_billing_address: false,
    has_marketing_email_consent: false,
    created_at: "",
    updated_at: "",
    language: "",
    start_of_the_week: EStartOfTheWeek.SUNDAY,
  };

  // PPM: the user (id) who picked the first day of the week themselves (see resolvePpmStartOfWeek)
  weekStartExplicitUserId: string | undefined = undefined;

  // services
  userService: UserService;

  constructor(public store: CoreRootStore) {
    makeObservable(this, {
      // observables
      isLoading: observable.ref,
      error: observable,
      data: observable,
      weekStartExplicitUserId: observable.ref,
      // computed
      startOfTheWeek: computed,
      // actions
      fetchUserProfile: action,
      updateUserProfile: action,
      updateTourCompleted: action,
      updateUserTheme: action,
    });
    // services
    this.userService = new UserService();
  }

  /**
   * The first day of the week for calendars and date pickers: the stored preference, except that the Russian PPM
   * interface starts on Monday until the user picks a day explicitly.
   */
  get startOfTheWeek(): EStartOfTheWeek {
    const language =
      this.data.language || (typeof window === "undefined" ? undefined : localStorage.getItem(LANGUAGE_STORAGE_KEY));
    return resolvePpmStartOfWeek(this.data.start_of_the_week, {
      shellEnabled: isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED),
      language: language ?? undefined,
      explicit: !!this.data.user && this.weekStartExplicitUserId === this.data.user,
    });
  }

  // helper action
  mutateUserProfile = (data: Partial<TUserProfile>) => {
    if (!data) return;
    Object.entries(data).forEach(([key, value]) => {
      if (key in this.data) set(this.data, key, value);
    });
  };

  // actions
  /**
   * @description fetches user profile information
   * @returns {Promise<TUserProfile | undefined>}
   */
  fetchUserProfile = async (): Promise<TUserProfile | undefined> => {
    try {
      runInAction(() => {
        this.isLoading = true;
        this.error = undefined;
      });
      const userProfile = await this.userService.getCurrentUserProfile();
      const shouldInitializeLanguage = shouldInitializePpmProfileLanguage({
        isOnboarded: userProfile.is_onboarded,
        profileLanguage: userProfile.language,
        shellEnabled: isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED),
        storedLanguage: typeof window === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY),
      });
      const resolvedUserProfile = shouldInitializeLanguage
        ? { ...userProfile, language: PPM_DEFAULT_LANGUAGE }
        : userProfile;

      if (shouldInitializeLanguage) {
        await this.userService.updateCurrentUserProfile({ language: PPM_DEFAULT_LANGUAGE });
      }
      runInAction(() => {
        this.isLoading = false;
        this.data = resolvedUserProfile;
        this.weekStartExplicitUserId = readPpmWeekStartExplicit(resolvedUserProfile.user)
          ? resolvedUserProfile.user
          : undefined;
      });
      if (resolvedUserProfile.language) {
        void setLanguage(resolvedUserProfile.language as TLanguage);
      }
      return resolvedUserProfile;
    } catch (error) {
      runInAction(() => {
        this.isLoading = false;
        this.error = {
          status: "user-profile-fetch-error",
          message: "Failed to fetch user profile",
        };
      });
      throw error;
    }
  };

  /**
   * @description updated the user profile information
   * @param {Partial<TUserProfile>} data
   * @returns {Promise<TUserProfile | undefined>}
   */
  updateUserProfile = async (data: Partial<TUserProfile>): Promise<TUserProfile | undefined> => {
    const currentUserProfileData = this.data;
    try {
      if (currentUserProfileData) {
        this.mutateUserProfile(data);
      }
      if (data.language) {
        void setLanguage(data.language as TLanguage);
      }
      const userProfile = await this.userService.updateCurrentUserProfile(data);
      // Only a saved choice counts as explicit (a failed PATCH leaves the Russian Monday default in place).
      if (data.start_of_the_week !== undefined) {
        const userId = this.data.user;
        markPpmWeekStartExplicit(userId);
        runInAction(() => {
          this.weekStartExplicitUserId = userId;
        });
      }
      return userProfile;
    } catch {
      if (currentUserProfileData) {
        this.mutateUserProfile(currentUserProfileData);
      }
      runInAction(() => {
        this.error = {
          status: "user-profile-update-error",
          message: "Failed to update user profile",
        };
      });
    }
  };

  /**
   * @description finishes the user onboarding
   * @returns { void }
   */
  finishUserOnboarding = async (): Promise<void> => {
    try {
      const firstWorkspace = Object.values(this.store.workspaceRoot.workspaces ?? {})?.[0];
      const dataToUpdate: Partial<TUserProfile> = {
        onboarding_step: {
          profile_complete: true,
          workspace_join: true,
          workspace_create: true,
          workspace_invite: true,
        },
        last_workspace_id: firstWorkspace?.id,
      };

      // update user onboarding steps
      await this.userService.updateCurrentUserProfile(dataToUpdate);

      // update user onboarding status
      await this.userService.updateUserOnBoard();

      // Wait for user settings to be refreshed with cache-busting before updating onboarding status
      await Promise.all([
        this.fetchUserProfile(),
        this.store.user.userSettings.fetchCurrentUserSettings(true), // Cache-busting enabled
      ]);

      // Only after settings are refreshed, update the user profile store to mark as onboarded
      runInAction(() => {
        this.mutateUserProfile({ ...dataToUpdate, is_onboarded: true });
      });
    } catch (error) {
      runInAction(() => {
        this.error = {
          status: "user-profile-onboard-finish-error",
          message: "Failed to finish user onboarding",
        };
      });
      throw error;
    }
  };

  /**
   * @description updates the user tour completed status
   * @returns @returns {Promise<TUserProfile | undefined>}
   */
  updateTourCompleted = async () => {
    const isUserProfileTourCompleted = this.data.is_tour_completed || false;
    try {
      this.mutateUserProfile({ is_tour_completed: true });
      const userProfile = await this.userService.updateUserTourCompleted();
      return userProfile;
    } catch (error) {
      runInAction(() => {
        this.mutateUserProfile({ is_tour_completed: isUserProfileTourCompleted });
        this.error = {
          status: "user-profile-tour-complete-error",
          message: "Failed to update user profile is_tour_completed",
        };
      });
      throw error;
    }
  };

  /**
   * @description updates the user theme
   * @returns @returns {Promise<TUserProfile | undefined>}
   */
  updateUserTheme = async (data: Partial<IUserTheme>) => {
    const currentProfileTheme = cloneDeep(this.data.theme);
    try {
      runInAction(() => {
        Object.keys(data).forEach((key) => {
          const dataKey = key as keyof IUserTheme;
          if (this.data.theme) set(this.data.theme, dataKey, data[dataKey]);
        });
      });
      const userProfile = await this.userService.updateCurrentUserProfile({
        theme: this.data.theme,
      });
      return userProfile;
    } catch (error) {
      runInAction(() => {
        Object.keys(data).forEach((key: string) => {
          const userKey: keyof IUserTheme = key as keyof IUserTheme;
          if (currentProfileTheme) set(this.data.theme, userKey, currentProfileTheme[userKey]);
        });
        this.error = {
          status: "user-profile-theme-update-error",
          message: "Failed to update user profile theme",
        };
      });
      throw error;
    }
  };
}
