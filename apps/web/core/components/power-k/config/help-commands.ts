/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { BookOpen, FileText, GithubIcon, MessageSquare, Rocket } from "lucide-react";
import { isPpmShellEnabled, PPM_SOURCE_ATTRIBUTION } from "@ppm/brand";
// components
import type { TPowerKCommandConfig } from "@/components/power-k/core/types";
// hooks
import { usePowerK } from "@/hooks/store/use-power-k";

/**
 * Help commands - Help related commands
 */
export const usePowerKHelpCommands = (): TPowerKCommandConfig[] => {
  // store
  const { toggleShortcutsListModal } = usePowerK();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  return [
    {
      id: "open_keyboard_shortcuts",
      type: "action",
      group: "help",
      i18n_title: "power_k.help_actions.open_keyboard_shortcuts",
      icon: Rocket,
      modifierShortcut: "cmd+/",
      action: () => toggleShortcutsListModal(true),
      isEnabled: () => true,
      isVisible: () => true,
      closeOnSelect: true,
    },
    {
      id: "open_plane_documentation",
      type: "action",
      group: "help",
      i18n_title: "power_k.help_actions.open_plane_documentation",
      icon: isPpmShell ? BookOpen : FileText,
      action: () => {
        const href = isPpmShell ? "/about/ppm-guide" : "https://docs.plane.so/";
        window.open(href, "_blank", "noopener,noreferrer");
      },
      isEnabled: () => true,
      isVisible: () => true,
      closeOnSelect: true,
    },
    {
      id: "join_forum",
      type: "action",
      group: "help",
      i18n_title: "power_k.help_actions.join_forum",
      icon: MessageSquare,
      action: () => {
        window.open("https://forum.plane.so", "_blank", "noopener,noreferrer");
      },
      isEnabled: () => true,
      isVisible: () => !isPpmShell,
      closeOnSelect: true,
    },
    {
      id: "report_bug",
      type: "action",
      group: "help",
      i18n_title: "power_k.help_actions.report_bug",
      icon: GithubIcon,
      action: () => {
        const href = isPpmShell
          ? `${PPM_SOURCE_ATTRIBUTION.repository}/issues/new`
          : "https://github.com/makeplane/plane/issues/new/choose";
        window.open(href, "_blank", "noopener,noreferrer");
      },
      isEnabled: () => true,
      isVisible: () => true,
      closeOnSelect: true,
    },
  ];
};
