/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ElementType } from "react";
import { Code2, Gauge, Network, Settings } from "lucide-react";
import { EUserPermissions } from "@plane/constants";
import { CycleIcon, IntakeIcon, ModuleIcon, PageIcon, ViewsIcon, WorkItemsIcon } from "@plane/propel/icons";
import type { EUserProjectRoles, IPartialProject } from "@plane/types";
import { getPpmProjectPath } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";

export type TPpmNavigationSection = "context" | "work" | "knowledge" | "code" | "project";

export type TProjectNavigationItem = {
  name: string;
  href: string;
  icon: ElementType;
  access: EUserPermissions[] | EUserProjectRoles[];
  shouldRender: boolean;
  sortOrder: number;
  i18n_key: string;
  key: string;
  ppmLabelKey?: TPpmTranslationKey;
  ppmSection?: TPpmNavigationSection;
};

type TBuildProjectNavigationItems = {
  isPpmCanvasEnabled: boolean;
  isPpmShellEnabled: boolean;
  project?: IPartialProject;
  projectId: string;
  workspaceSlug: string;
};

const ALL_PROJECT_MEMBERS = [EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST];
const PROJECT_EDITORS = [EUserPermissions.ADMIN, EUserPermissions.MEMBER];
const PROJECT_LEADS = [EUserPermissions.ADMIN];

export function buildProjectNavigationItems({
  isPpmCanvasEnabled,
  isPpmShellEnabled,
  project,
  projectId,
  workspaceSlug,
}: TBuildProjectNavigationItems): TProjectNavigationItem[] {
  if (!isPpmShellEnabled) return buildPlaneNavigationItems(workspaceSlug, projectId, project);

  return [
    {
      i18n_key: "overview",
      key: "overview",
      name: "Overview",
      href: getPpmProjectPath(workspaceSlug, projectId, "overview"),
      icon: Gauge,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: true,
      sortOrder: 1,
      ppmLabelKey: "project.overview",
      ppmSection: "context",
    },
    {
      i18n_key: "brain",
      key: "brain",
      name: "Canvas",
      href: getPpmProjectPath(workspaceSlug, projectId, "brain"),
      icon: Network,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: isPpmCanvasEnabled,
      sortOrder: 2,
      ppmLabelKey: "project.brain",
      ppmSection: "context",
    },
    {
      i18n_key: "sidebar.work_items",
      key: "work_items",
      name: "Tasks",
      href: getPpmProjectPath(workspaceSlug, projectId, "tasks"),
      icon: WorkItemsIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: true,
      sortOrder: 10,
      ppmLabelKey: "project.tasks",
      ppmSection: "work",
    },
    {
      i18n_key: "sidebar.views",
      key: "views",
      name: "Views",
      href: getPpmProjectPath(workspaceSlug, projectId, "views"),
      icon: ViewsIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.issue_views_view ?? false,
      sortOrder: 11,
      ppmLabelKey: "project.views",
      ppmSection: "work",
    },
    {
      i18n_key: "sidebar.cycles",
      key: "cycles",
      name: "Stages",
      href: getPpmProjectPath(workspaceSlug, projectId, "stages"),
      icon: CycleIcon,
      access: PROJECT_EDITORS,
      shouldRender: project?.cycle_view ?? false,
      sortOrder: 12,
      ppmLabelKey: "project.stages",
      ppmSection: "work",
    },
    {
      i18n_key: "sidebar.modules",
      key: "modules",
      name: "Directions",
      href: getPpmProjectPath(workspaceSlug, projectId, "directions"),
      icon: ModuleIcon,
      access: PROJECT_EDITORS,
      shouldRender: project?.module_view ?? false,
      sortOrder: 13,
      ppmLabelKey: "project.directions",
      ppmSection: "work",
    },
    {
      i18n_key: "sidebar.intake",
      key: "intake",
      name: "Intake",
      href: getPpmProjectPath(workspaceSlug, projectId, "intake"),
      icon: IntakeIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.inbox_view ?? false,
      sortOrder: 14,
      ppmLabelKey: "project.intake",
      ppmSection: "work",
    },
    {
      i18n_key: "knowledge",
      key: "knowledge",
      name: "Knowledge",
      href: getPpmProjectPath(workspaceSlug, projectId, "knowledge"),
      icon: PageIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: true,
      sortOrder: 20,
      ppmLabelKey: "project.knowledge",
      ppmSection: "knowledge",
    },
    {
      i18n_key: "sidebar.pages",
      key: "pages",
      name: "Collaborative pages",
      href: getPpmProjectPath(workspaceSlug, projectId, "pages"),
      icon: PageIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.page_view ?? false,
      sortOrder: 21,
      ppmLabelKey: "project.collaborative_pages",
      ppmSection: "knowledge",
    },
    {
      i18n_key: "code",
      key: "code",
      name: "Code",
      href: getPpmProjectPath(workspaceSlug, projectId, "code"),
      icon: Code2,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: true,
      sortOrder: 30,
      ppmLabelKey: "project.code",
      ppmSection: "code",
    },
    {
      i18n_key: "settings",
      key: "settings",
      name: "Project settings",
      href: `/${workspaceSlug}/settings/projects/${projectId}`,
      icon: Settings,
      access: PROJECT_LEADS,
      shouldRender: true,
      sortOrder: 40,
      ppmLabelKey: "project.settings",
      ppmSection: "project",
    },
  ];
}

function buildPlaneNavigationItems(
  workspaceSlug: string,
  projectId: string,
  project?: IPartialProject
): TProjectNavigationItem[] {
  return [
    {
      i18n_key: "sidebar.work_items",
      key: "work_items",
      name: "Work items",
      href: `/${workspaceSlug}/projects/${projectId}/issues`,
      icon: WorkItemsIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: true,
      sortOrder: 1,
    },
    {
      i18n_key: "sidebar.cycles",
      key: "cycles",
      name: "Cycles",
      href: `/${workspaceSlug}/projects/${projectId}/cycles`,
      icon: CycleIcon,
      access: PROJECT_EDITORS,
      shouldRender: project?.cycle_view ?? false,
      sortOrder: 2,
    },
    {
      i18n_key: "sidebar.modules",
      key: "modules",
      name: "Modules",
      href: `/${workspaceSlug}/projects/${projectId}/modules`,
      icon: ModuleIcon,
      access: PROJECT_EDITORS,
      shouldRender: project?.module_view ?? false,
      sortOrder: 3,
    },
    {
      i18n_key: "sidebar.views",
      key: "views",
      name: "Views",
      href: `/${workspaceSlug}/projects/${projectId}/views`,
      icon: ViewsIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.issue_views_view ?? false,
      sortOrder: 4,
    },
    {
      i18n_key: "sidebar.pages",
      key: "pages",
      name: "Pages",
      href: `/${workspaceSlug}/projects/${projectId}/pages`,
      icon: PageIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.page_view ?? false,
      sortOrder: 5,
    },
    {
      i18n_key: "sidebar.intake",
      key: "intake",
      name: "Intake",
      href: `/${workspaceSlug}/projects/${projectId}/intake`,
      icon: IntakeIcon,
      access: ALL_PROJECT_MEMBERS,
      shouldRender: project?.inbox_view ?? false,
      sortOrder: 6,
    },
  ];
}

// UX1.1: labelled groups of the project navigation (spec C: «Работа», «Знания»); other sections have no label.
export const PPM_NAVIGATION_SECTION_LABEL_KEYS: Partial<Record<TPpmNavigationSection, TPpmTranslationKey>> = {
  work: "ux.nav.section_work",
  knowledge: "ux.nav.section_knowledge",
};

export type TProjectNavigationRun = {
  key: string;
  section?: TPpmNavigationSection;
  items: TProjectNavigationItem[];
};

/** Splits already-filtered items into runs of consecutive items of one section, keeping the canonical order. */
export function groupProjectNavigationItems(items: TProjectNavigationItem[]): TProjectNavigationRun[] {
  const runs: TProjectNavigationRun[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && item.ppmSection !== undefined && last.section === item.ppmSection) last.items.push(item);
    else runs.push({ key: `${item.ppmSection ?? "item"}-${item.key}`, section: item.ppmSection, items: [item] });
  }
  return runs;
}
