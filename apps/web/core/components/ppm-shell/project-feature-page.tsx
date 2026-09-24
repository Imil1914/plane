/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ArrowRight, BrainCircuit, Code2, FileText, Gauge, ListTodo } from "lucide-react";
import Link from "next/link";
import { Navigate } from "react-router";
import { isPpmShellEnabled, getPpmProjectPath } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { isPpmCanvasEnabled } from "@ppm/canvas";
import { PageHead } from "@/components/core/page-title";
import { useProject } from "@/hooks/store/use-project";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export type TPpmProjectFeature = "brain" | "code" | "knowledge" | "overview";

type TPpmProjectFeaturePageProps = {
  feature: TPpmProjectFeature;
  projectId: string;
  workspaceSlug: string;
};

const FEATURE_CONFIG: Record<
  Exclude<TPpmProjectFeature, "overview">,
  {
    descriptionKey: TPpmTranslationKey;
    eyebrowKey: TPpmTranslationKey;
    icon: typeof BrainCircuit;
    plannedKey: TPpmTranslationKey;
    titleKey: TPpmTranslationKey;
  }
> = {
  brain: {
    descriptionKey: "brain.description",
    eyebrowKey: "brain.eyebrow",
    icon: BrainCircuit,
    plannedKey: "brain.planned",
    titleKey: "brain.title",
  },
  knowledge: {
    descriptionKey: "knowledge.description",
    eyebrowKey: "knowledge.eyebrow",
    icon: FileText,
    plannedKey: "knowledge.planned",
    titleKey: "knowledge.title",
  },
  code: {
    descriptionKey: "code.description",
    eyebrowKey: "code.eyebrow",
    icon: Code2,
    plannedKey: "code.planned",
    titleKey: "code.title",
  },
};

export function PpmProjectFeaturePage({ feature, projectId, workspaceSlug }: TPpmProjectFeaturePageProps) {
  const ppmT = usePpmTranslation();
  const { getPartialProjectById } = useProject();
  const project = getPartialProjectById(projectId);
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const isCanvasEnabled = isPpmCanvasEnabled(process.env.PPM_CANVAS_ENABLED, isPpmShell);

  if (!isPpmShell) return <Navigate replace to={getPpmProjectPath(workspaceSlug, projectId, "tasks")} />;

  if (feature === "overview") {
    return (
      <ProjectPageFrame
        pageTitle={`${project?.name ?? "PPM"} — ${ppmT("overview.title")}`}
        eyebrow={ppmT("overview.eyebrow")}
        title={project?.name ?? ppmT("overview.title")}
        description={ppmT("overview.description")}
        icon={Gauge}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FeatureCard
            href={getPpmProjectPath(workspaceSlug, projectId, "tasks")}
            icon={ListTodo}
            title={ppmT("project.tasks")}
            description={ppmT("overview.tasks_description")}
            status={ppmT("status.available")}
            available
          />
          {isCanvasEnabled && (
            <FeatureCard
              href={getPpmProjectPath(workspaceSlug, projectId, "brain")}
              icon={BrainCircuit}
              title={ppmT("project.brain")}
              description={ppmT("brain.description")}
              status={ppmT("status.available")}
              available
            />
          )}
          <FeatureCard
            href={getPpmProjectPath(workspaceSlug, projectId, "knowledge")}
            icon={FileText}
            title={ppmT("project.knowledge")}
            description={ppmT("knowledge.description")}
            status={ppmT("status.available")}
            available
          />
          <FeatureCard
            href={getPpmProjectPath(workspaceSlug, projectId, "code")}
            icon={Code2}
            title={ppmT("project.code")}
            description={ppmT("code.description")}
            status={ppmT("status.available")}
            available
          />
        </div>
        <div className="rounded-xl border border-subtle bg-surface-2 p-5">
          <h2 className="text-16 font-semibold text-primary">{ppmT("overview.next_title")}</h2>
          <p className="mt-1 max-w-2xl text-13 leading-5 text-secondary">{ppmT("overview.next_description")}</p>
          <Link
            href={getPpmProjectPath(workspaceSlug, projectId, "tasks")}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-13 font-semibold text-on-accent hover:bg-accent-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
          >
            {ppmT("actions.open_tasks")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </ProjectPageFrame>
    );
  }

  const config = FEATURE_CONFIG[feature];

  return (
    <ProjectPageFrame
      pageTitle={`${project?.name ?? "PPM"} — ${ppmT(config.titleKey)}`}
      eyebrow={ppmT(config.eyebrowKey)}
      title={ppmT(config.titleKey)}
      description={ppmT(config.descriptionKey)}
      icon={config.icon}
    >
      <div className="max-w-3xl rounded-xl border border-subtle bg-surface-2 p-5 sm:p-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-subtle bg-layer-1 px-2.5 py-1 text-11 font-semibold text-accent-primary">
          <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden="true" />
          {ppmT("status.planned")}
        </div>
        <p className="mt-4 text-14 leading-6 text-secondary">{ppmT(config.plannedKey)}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={getPpmProjectPath(workspaceSlug, projectId, "tasks")}
            className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-13 font-semibold text-on-accent hover:bg-accent-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
          >
            {ppmT("actions.open_tasks")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <Link
            href={getPpmProjectPath(workspaceSlug, projectId, "overview")}
            className="inline-flex items-center rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 font-semibold text-primary hover:bg-layer-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
          >
            {ppmT("actions.back_overview")}
          </Link>
        </div>
      </div>
    </ProjectPageFrame>
  );
}

type TProjectPageFrameProps = {
  children: React.ReactNode;
  description: string;
  eyebrow: string;
  icon: typeof BrainCircuit;
  pageTitle: string;
  title: string;
};

function ProjectPageFrame({ children, description, eyebrow, icon: Icon, pageTitle, title }: TProjectPageFrameProps) {
  return (
    <>
      <PageHead title={pageTitle} />
      <div className="h-full overflow-y-auto bg-surface-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-12">
          <header className="flex max-w-3xl items-start gap-4">
            <div className="mt-1 grid size-11 shrink-0 place-items-center rounded-xl border border-subtle bg-surface-2 text-accent-primary">
              <Icon className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-11 font-semibold tracking-[0.12em] text-accent-primary uppercase">{eyebrow}</p>
              <h1 className="mt-2 text-24 font-semibold tracking-tight text-primary sm:text-28">{title}</h1>
              <p className="mt-2 text-14 leading-6 text-secondary">{description}</p>
            </div>
          </header>
          {children}
        </div>
      </div>
    </>
  );
}

type TFeatureCardProps = {
  available?: boolean;
  description: string;
  href: string;
  icon: typeof BrainCircuit;
  status: string;
  title: string;
};

function FeatureCard({ available = false, description, href, icon: Icon, status, title }: TFeatureCardProps) {
  return (
    <Link
      href={href}
      className="group flex min-h-44 flex-col rounded-xl border border-subtle bg-surface-2 p-4 transition-colors hover:border-strong hover:bg-layer-1-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid size-9 place-items-center rounded-lg bg-layer-1 text-accent-primary">
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <span
          className={available ? "text-11 font-semibold text-success-primary" : "text-11 font-medium text-tertiary"}
        >
          {status}
        </span>
      </div>
      <h2 className="mt-5 text-14 font-semibold text-primary">{title}</h2>
      <p className="mt-1 line-clamp-2 text-12 leading-5 text-secondary">{description}</p>
      <ArrowRight
        className="mt-auto size-4 self-end text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
        aria-hidden="true"
      />
    </Link>
  );
}
