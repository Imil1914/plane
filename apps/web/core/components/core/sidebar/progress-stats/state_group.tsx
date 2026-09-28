/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { StateGroupIcon } from "@plane/propel/icons";
import type { TStateGroups } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
// components
import { SingleProgressStats } from "@/components/core/sidebar/single-progress-stats";

const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

export type TStateGroupData = {
  state: string | undefined;
  completed: number;
  total: number;
}[];

type TStateGroupStatComponent = {
  selectedStateGroups: string[];
  handleStateGroupFiltersUpdate: (stateGroup: string | undefined) => void;
  distribution: TStateGroupData;
  totalIssuesCount: number;
  isEditable?: boolean;
};

export const StateGroupStatComponent = observer(function StateGroupStatComponent(props: TStateGroupStatComponent) {
  const { distribution, isEditable, totalIssuesCount, selectedStateGroups, handleStateGroupFiltersUpdate } = props;
  const { t } = useTranslation();

  return (
    <div>
      {distribution.map((group, index) => (
        <SingleProgressStats
          key={index}
          title={
            <div className="flex items-center gap-2">
              <StateGroupIcon stateGroup={group.state as TStateGroups} />
              {/* PPM line S4: the state group by its Russian name (the raw key is English, title-cased by CSS) */}
              <span className={`text-11 ${isPpmShell ? "" : "capitalize"}`}>
                {isPpmShell ? t(`workspace_projects.state.${group.state}`) : group.state}
              </span>
            </div>
          }
          completed={group.completed}
          total={totalIssuesCount}
          {...(isEditable && {
            onClick: () => group.state && handleStateGroupFiltersUpdate(group.state),
            selected: group.state ? selectedStateGroups.includes(group.state) : false,
          })}
        />
      ))}
    </div>
  );
});
