/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTheme } from "next-themes";
// plane imports
import { useTranslation } from "@plane/i18n";
import { getPpmTranslation, isPpmShellEnabled } from "@ppm/brand";
// assets
import githubBlackImage from "@/app/assets/logos/github-black.png?url";
import githubWhiteImage from "@/app/assets/logos/github-white.png?url";

export function StarUsOnGitHubLink() {
  // plane hooks
  const { currentLocale, t } = useTranslation();
  // hooks
  const { resolvedTheme } = useTheme();
  const imageSrc = resolvedTheme === "dark" ? githubWhiteImage : githubBlackImage;
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const label = isPpmShell ? getPpmTranslation(currentLocale, "brand.open_source") : t("home.star_us_on_github");

  return (
    <a
      aria-label={label}
      className="flex flex-shrink-0 items-center gap-1.5 rounded-sm bg-layer-2 px-3 py-1.5"
      href={isPpmShell ? "/about/open-source" : "https://github.com/makeplane/plane"}
      target={isPpmShell ? undefined : "_blank"}
      rel={isPpmShell ? undefined : "noopener noreferrer"}
    >
      <img src={imageSrc} className="h-4 w-4 object-contain" alt="GitHub Logo" aria-hidden="true" />
      <span className="hidden text-11 font-medium sm:hidden md:block">{label}</span>
    </a>
  );
}
