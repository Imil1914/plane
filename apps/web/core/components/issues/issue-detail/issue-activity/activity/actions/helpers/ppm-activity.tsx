/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import type { TPpmTranslationKey } from "@ppm/brand";
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

/**
 * One activity sentence in the PPM interface language: «изменил(а) статус на «В работе».». The author's name is
 * rendered before it by IssueActivityBlockComponent; `issue` (lists outside the work item) goes after a dash.
 */
export function PpmActivityPhrase(props: {
  phrase: TPpmTranslationKey;
  values?: Record<string, ReactNode>;
  issue?: ReactNode;
}) {
  const { phrase, values = {}, issue } = props;
  const ppmT = usePpmTranslation();

  return (
    <>
      <PpmTemplateText template={ppmT(phrase)} values={values} />
      {issue ? <> — {issue}</> : null}.
    </>
  );
}
