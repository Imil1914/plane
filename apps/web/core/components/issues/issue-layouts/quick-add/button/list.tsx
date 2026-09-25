/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";

import { useTranslation } from "@plane/i18n";
import { PlusIcon } from "@plane/propel/icons";
import { Row } from "@plane/ui";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import type { TQuickAddIssueButton } from "../root";

export const ListQuickAddIssueButton = observer(function ListQuickAddIssueButton(props: TQuickAddIssueButton) {
  const { onClick, isEpic = false } = props;
  const { t } = useTranslation();
  const isDesignV2 = usePpmDesignV2();
  if (isDesignV2)
    return (
      <Row className="ppm-task-quick-add flex w-full items-center bg-layer-transparent">
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2 self-stretch text-left text-13 font-medium text-tertiary hover:text-secondary"
        >
          <PlusIcon aria-hidden="true" className="h-3.5 w-3.5 stroke-2" />
          <span>{isEpic ? t("epic.new") : t("issue.new")}</span>
        </button>
      </Row>
    );
  return (
    <Row
      className="flex w-full cursor-pointer items-center gap-2 bg-layer-transparent py-3 hover:bg-layer-transparent-hover"
      onClick={onClick}
    >
      <PlusIcon className="h-3.5 w-3.5 stroke-2" />
      <span className="text-13 font-medium">{isEpic ? t("epic.new") : t("issue.new")}</span>
    </Row>
  );
});
