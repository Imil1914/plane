/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IWebhook } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
// ui
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { DeleteWebhookModal, WebhookDeleteSection, WebhookForm } from "@/components/web-hooks";
// hooks
import { useWebhook } from "@/hooks/store/use-webhook";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
import { usePpmText } from "@/hooks/use-ppm-text";
// local imports
import type { Route } from "./+types/page";
import { WebhookDetailsWorkspaceSettingsHeader } from "./header";

function WebhookDetailsPage({ params }: Route.ComponentProps) {
  // states
  const [deleteWebhookModal, setDeleteWebhookModal] = useState(false);
  // router
  const { workspaceSlug, webhookId } = params;
  // mobx store
  const { currentWebhook, fetchWebhookById, updateWebhook } = useWebhook();
  const { currentWorkspace } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  const { t } = useTranslation();
  const ppmText = usePpmText();

  // TODO: fix this error
  // useEffect(() => {
  //   if (isCreated !== "true") clearSecretKey();
  // }, [clearSecretKey, isCreated]);
  // derived values
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  // No singular webhook i18n key exists, so the PPM path reuses the plural
  // workspace_settings.settings.webhooks.title key; gated so non-PPM users keep the
  // upstream singular title unchanged.
  const webhookTitleSuffix = isPpmShell ? t("workspace_settings.settings.webhooks.title") : "Webhook";
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace.name} - ${webhookTitleSuffix}` : undefined;

  useSWR(
    isAdmin ? `WEBHOOK_DETAILS_${workspaceSlug}_${webhookId}` : null,
    isAdmin ? () => fetchWebhookById(workspaceSlug, webhookId) : null
  );

  const handleUpdateWebhook = async (formData: IWebhook) => {
    if (!formData || !formData.id) return;

    const payload = {
      url: formData.url,
      is_active: formData.is_active,
      project: formData.project,
      cycle: formData.cycle,
      module: formData.module,
      issue: formData.issue,
      issue_comment: formData.issue_comment,
    };

    try {
      await updateWebhook(workspaceSlug, formData.id, payload);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: ppmText("ui.toast.success", "Success!"),
        message: ppmText("ui.webhook.updated", "Webhook updated successfully."),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: ppmText("ui.toast.error", "Error!"),
        message: error?.error ?? ppmText("ui.toast.try_again_now", "Something went wrong. Please try again."),
      });
    }
  };

  if (!isAdmin)
    return (
      <>
        <PageHead title={pageTitle} />
        <div className="mt-10 flex h-full w-full justify-center p-4">
          <p className="text-13 text-tertiary">
            {ppmText("ui.webhook.not_authorized", "You are not authorized to access this page.")}
          </p>
        </div>
      </>
    );

  if (!currentWebhook)
    return (
      <div className="grid h-full w-full place-items-center p-4">
        <LogoSpinner />
      </div>
    );

  return (
    <SettingsContentWrapper header={<WebhookDetailsWorkspaceSettingsHeader />}>
      <PageHead title={pageTitle} />
      <DeleteWebhookModal isOpen={deleteWebhookModal} onClose={() => setDeleteWebhookModal(false)} />
      <div className="w-full space-y-8 overflow-y-auto">
        <div>
          <WebhookForm onSubmit={handleUpdateWebhook} data={currentWebhook} />
        </div>
        {currentWebhook && <WebhookDeleteSection openDeleteModal={() => setDeleteWebhookModal(true)} />}
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(WebhookDetailsPage);
