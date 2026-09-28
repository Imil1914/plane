/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
import { InstanceFailureView } from "@/components/instance/failure";
import { InstanceSetupForm } from "@/components/instance/setup-form";
// hooks
import { useInstance } from "@/hooks/store";
import { getPpmTranslation } from "@ppm/brand";
// components
import type { Route } from "./+types/page";
import { IS_PPM_SHELL_ENABLED, getAuthLanguage } from "./ppm-auth-language";
import { InstanceSignInForm } from "./sign-in-form";

function HomePage() {
  // store hooks
  const { instance, error } = useInstance();

  // if instance is not fetched, show loading
  if (!instance && !error) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <LogoSpinner />
      </div>
    );
  }

  // if instance fetch fails, show failure view
  if (error) {
    return <InstanceFailureView />;
  }

  // if instance is fetched and setup is not done, show setup form
  if (instance && !instance?.is_setup_done) {
    return <InstanceSetupForm />;
  }

  // if instance is fetched and setup is done, show sign in form
  return <InstanceSignInForm />;
}

export default observer(HomePage);

export const meta: Route.MetaFunction = () => {
  if (!IS_PPM_SHELL_ENABLED)
    return [
      { title: "Admin – Instance Setup & Sign-In" },
      { name: "description", content: "Configure your Plane instance or sign in to the admin portal." },
    ];
  // PPM line L: the tab title in the interface language.
  const language = getAuthLanguage();
  return [
    { title: getPpmTranslation(language, "auth.admin_page_title") },
    { name: "description", content: getPpmTranslation(language, "auth.admin_page_description") },
  ];
};
