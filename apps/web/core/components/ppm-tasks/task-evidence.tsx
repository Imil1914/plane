/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import type { IIssueDisplayProperties, TIssue, TIssueMap } from "@plane/types";
import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmTasksData } from "./data-context";
import {
  collectPpmActiveBlockers,
  countPpmMaterials,
  formatPpmIssueIdentifier,
  formatPpmPullRequestRef,
  isPpmActiveStateGroup,
} from "./evidence";
import { formatPpmTemplate } from "./format";
import { PpmTaskBlockedMarkerView, PpmTaskEvidenceView } from "./task-evidence-view";

export const PpmTaskEvidence = observer(function PpmTaskEvidence(props: {
  issue: TIssue;
  displayProperties: IIssueDisplayProperties | undefined;
}) {
  const { issue, displayProperties } = props;
  const data = usePpmTasksData();
  const ppmT = usePpmTranslation();
  if (!data) return null;
  const pulls = data.pullRequestsByIssue.get(issue.id) ?? [];
  const firstRef = pulls[0] ? formatPpmPullRequestRef(pulls[0].ref) : null;
  const pullRequest = pulls.length
    ? {
        label: firstRef ?? ppmT("tasks.evidence.pr_label"),
        srLabel: formatPpmTemplate(ppmT("tasks.evidence.pr"), { ref: firstRef ?? "" }).trim(),
        more: pulls.length - 1,
        titles: pulls.map((item) => item.title || item.ref).join("\n"),
      }
    : null;
  const counts = countPpmMaterials(issue, displayProperties);
  const materials =
    counts.total > 0
      ? {
          count: counts.total,
          srLabel: formatPpmTemplate(ppmT("tasks.evidence.materials"), { count: counts.total }),
          title: formatPpmTemplate(ppmT("tasks.evidence.materials_hint"), {
            attachments: counts.attachments,
            links: counts.links,
          }),
        }
      : null;
  return <PpmTaskEvidenceView pullRequest={pullRequest} materials={materials} />;
});

export const PpmTaskBlockedMarker = observer(function PpmTaskBlockedMarker(props: {
  issue: TIssue;
  issuesMap: TIssueMap;
}) {
  const { issue, issuesMap } = props;
  const data = usePpmTasksData();
  const ppmT = usePpmTranslation();
  const { getStateById } = useProjectState();
  const { getProjectIdentifierById } = useProject();
  if (!data || !isPpmActiveStateGroup(getStateById(issue.state_id)?.group)) return null;
  const relations = data.relationsByIssue.get(issue.id);
  if (!relations?.length) return null;
  const blockers = collectPpmActiveBlockers(
    relations,
    (stateId) => getStateById(stateId)?.group,
    (issueId) => issuesMap[issueId]?.state_id
  );
  if (!blockers.length) return null;
  const identifiers = blockers.map((blocker) =>
    formatPpmIssueIdentifier(getProjectIdentifierById(blocker.projectId), blocker.sequenceId)
  );
  const more = blockers.length - 1;
  const srText = [
    ppmT("tasks.evidence.blocked_by"),
    identifiers[0],
    more > 0 ? formatPpmTemplate(ppmT("tasks.evidence.blocked_more"), { count: more }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = blockers.map((blocker, index) => `${identifiers[index]} · ${blocker.name}`).join("\n");
  return <PpmTaskBlockedMarkerView srText={srText} identifier={identifiers[0]} more={more} title={title} />;
});
