/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Download } from "lucide-react";
// plane imports
import { Tooltip } from "@plane/propel/tooltip";
// helpers
import { editorText } from "@/helpers/ppm-text";

type Props = {
  src: string;
};

export function ImageDownloadAction(props: Props) {
  const { src } = props;

  return (
    <Tooltip tooltipContent={editorText("ui.editor.download", "Download")}>
      <button
        type="button"
        onClick={() => window.open(src, "_blank")}
        className="grid h-full flex-shrink-0 place-items-center text-white/60 transition-colors hover:text-white"
        aria-label={editorText("ui.editor.download_image", "Download image")}
      >
        <Download className="size-3" />
      </button>
    </Tooltip>
  );
}
