/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
// assets
import { cn } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
import ProjectNotAuthorizedImg from "@/app/assets/auth/project-not-authorized.svg?url";
import Unauthorized from "@/app/assets/auth/unauthorized.svg?url";
import WorkspaceNotAuthorizedImg from "@/app/assets/auth/workspace-not-authorized.svg?url";
// layouts
import DefaultLayout from "@/layouts/default-layout";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type Props = {
  actionButton?: React.ReactNode;
  section?: "settings" | "general";
  isProjectView?: boolean;
  className?: string;
};

export const NotAuthorizedView = observer(function NotAuthorizedView(props: Props) {
  const { actionButton, section = "general", isProjectView = false, className } = props;
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  // assets
  const settingAsset = isProjectView ? ProjectNotAuthorizedImg : WorkspaceNotAuthorizedImg;
  const asset = section === "settings" ? settingAsset : Unauthorized;

  return (
    <DefaultLayout className={cn("bg-surface-1", className)}>
      <div className="flex h-full w-full flex-col items-center justify-center gap-y-5 text-center">
        <div className="h-44 w-72">
          <img
            src={asset}
            className="h-[176px] w-[288px] object-contain"
            alt={isPpmShell ? ppmT("state.unauthorized_image_alt") : "Access restricted"}
          />
        </div>
        <h1 className="text-18 font-medium text-primary">
          {isPpmShell ? ppmT("state.unauthorized_title") : "You are not authorized to view this page"}
        </h1>
        {actionButton}
      </div>
    </DefaultLayout>
  );
});
