/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from "react";
import { BrainCircuit, LockKeyhole, RotateCcw } from "lucide-react";
import { Navigate } from "react-router";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { getPpmProjectPath, isPpmShellEnabled, type TPpmTranslationKey } from "@ppm/brand";
import { isPpmCanvasEnabled } from "@ppm/canvas";
import { PageHead } from "@/components/core/page-title";
import { useProject } from "@/hooks/store/use-project";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { resolvePpmCanvasAccess } from "./access";

const PpmCanvasEditor = lazy(() => import("./editor"));

type TPpmCanvasRouteProps = {
  projectId: string;
  workspaceSlug: string;
};

const PROJECT_MEMBERS = [EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST];
const PROJECT_EDITORS = [EUserPermissions.ADMIN, EUserPermissions.MEMBER];

export function PpmCanvasRoute({ projectId, workspaceSlug }: TPpmCanvasRouteProps) {
  const ppmT = usePpmTranslation();
  const { getPartialProjectById } = useProject();
  const { data: currentUser } = useUser();
  const { allowPermissions, getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const project = getPartialProjectById(projectId);
  const isShellEnabled = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const isCanvasEnabled = isPpmCanvasEnabled(process.env.PPM_CANVAS_ENABLED, isShellEnabled);

  if (!isCanvasEnabled) return <Navigate replace to={getPpmProjectPath(workspaceSlug, projectId, "tasks")} />;
  if (!project || !currentUser) return <CanvasState kind="loading" />;

  const role = getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug, projectId);
  const roleAccess = resolvePpmCanvasAccess(role);
  const canRead = allowPermissions(PROJECT_MEMBERS, EUserPermissionsLevel.PROJECT, workspaceSlug, projectId);
  const canEdit = allowPermissions(PROJECT_EDITORS, EUserPermissionsLevel.PROJECT, workspaceSlug, projectId);

  if (!canRead || roleAccess === "deny") return <CanvasState kind="denied" />;

  return (
    <>
      <PageHead title={`${project.name} — ${ppmT("brain.title")}`} />
      <main className="relative h-full min-h-0 overflow-hidden bg-surface-1" aria-label={ppmT("brain.title")}>
        <div className="pointer-events-none absolute top-3 left-3 z-[310] flex max-w-[calc(100%-1.5rem)] gap-2">
          <span className="shadow-sm rounded-full border border-subtle bg-surface-1/95 px-2.5 py-1 text-11 font-semibold text-primary backdrop-blur">
            {project.name}
          </span>
          <span className="shadow-sm rounded-full border border-subtle bg-surface-1/95 px-2.5 py-1 text-11 font-medium text-secondary backdrop-blur">
            {ppmT("canvas.local_badge")}
          </span>
        </div>
        <CanvasErrorBoundary>
          <Suspense fallback={<CanvasState kind="loading" />}>
            <PpmCanvasEditor
              authorId={currentUser.id}
              canEdit={canEdit && roleAccess === "edit"}
              projectId={projectId}
              workspaceSlug={workspaceSlug}
            />
          </Suspense>
        </CanvasErrorBoundary>
      </main>
    </>
  );
}

type TCanvasStateKind = "denied" | "error" | "loading";

function CanvasState({ kind }: { kind: TCanvasStateKind }) {
  const ppmT = usePpmTranslation();
  const config: Record<
    TCanvasStateKind,
    { description: TPpmTranslationKey; icon: typeof BrainCircuit; title: TPpmTranslationKey }
  > = {
    denied: {
      description: "canvas.permission_denied_description",
      icon: LockKeyhole,
      title: "canvas.permission_denied_title",
    },
    error: {
      description: "canvas.error_description",
      icon: RotateCcw,
      title: "canvas.error_title",
    },
    loading: {
      description: "canvas.loading_description",
      icon: BrainCircuit,
      title: "canvas.loading_title",
    },
  };
  const { description, icon: Icon, title } = config[kind];

  return (
    <div className="grid h-full min-h-80 place-items-center bg-surface-1 px-6">
      <div className="max-w-md text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-xl border border-subtle bg-surface-2 text-accent-primary">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-18 font-semibold text-primary">{ppmT(title)}</h1>
        <p className="mt-2 text-13 leading-5 text-secondary">{ppmT(description)}</p>
        {kind === "error" && (
          <button
            type="button"
            className="mt-4 rounded-md bg-accent-primary px-3 py-2 text-13 font-semibold text-on-color hover:bg-accent-primary-hover"
            onClick={() => window.location.reload()}
          >
            {ppmT("canvas.reload")}
          </button>
        )}
      </div>
    </div>
  );
}

class CanvasErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("PPM Canvas failed", error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) return <CanvasState kind="error" />;
    return this.props.children;
  }
}
