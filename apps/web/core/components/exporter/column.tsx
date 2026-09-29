/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Download } from "lucide-react";
import type { IExportData } from "@plane/types";
import { getDate, getFileURL, renderFormattedDate } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";
// hooks
import { usePpmCount, usePpmRu, usePpmText } from "@/hooks/use-ppm-text";

type RowData = IExportData;
const checkExpiry = (inputDateString: string) => {
  const currentDate = new Date();
  const expiryDate = getDate(inputDateString);
  if (!expiryDate) return false;
  expiryDate.setDate(expiryDate.getDate() + 7);
  return expiryDate > currentDate;
};
// Export statuses of the API → PPM keys (one word each: the status chip capitalizes every word).
const EXPORT_STATUS_KEYS: Record<string, TPpmTranslationKey> = {
  queued: "ui.export.status_queued",
  processing: "ui.export.status_processing",
  completed: "ui.export.status_completed",
  failed: "ui.export.status_failed",
  expired: "ui.export.status_expired",
};

export const useExportColumns = () => {
  const isPpmRu = usePpmRu();
  const ppmText = usePpmText();
  const ppmCount = usePpmCount();
  const exportStatus = (status: string) =>
    EXPORT_STATUS_KEYS[status] ? ppmText(EXPORT_STATUS_KEYS[status], status) : status;
  const columns = [
    {
      key: "Exported By",
      content: ppmText("ui.export.exported_by", "Exported By"),
      tdRender: (rowData: RowData) => {
        const { avatar_url, display_name, email } = rowData.initiated_by_detail;
        return (
          <div className="flex items-center gap-x-2">
            <div>
              {avatar_url && avatar_url.trim() !== "" ? (
                <span className="relative flex h-4 w-4 items-center justify-center rounded-full text-on-color capitalize">
                  <img
                    src={getFileURL(avatar_url)}
                    className="absolute top-0 left-0 h-full w-full rounded-full object-cover"
                    alt={display_name || email}
                  />
                </span>
              ) : (
                <span className="relative flex h-4 w-4 items-center justify-center rounded-full bg-layer-3 text-11 text-secondary capitalize">
                  {(email ?? display_name ?? "?")[0]}
                </span>
              )}
            </div>
            <div>{display_name}</div>
          </div>
        );
      },
    },
    {
      key: "Exported On",
      content: ppmText("ui.export.exported_on", "Exported On"),
      tdRender: (rowData: RowData) => <span>{renderFormattedDate(rowData.created_at)}</span>,
    },

    {
      key: "Exported projects",
      content: ppmText("ui.export.projects", "Exported projects"),
      tdRender: (rowData: RowData) => (
        <div className="text-13">
          {isPpmRu ? ppmCount("ui.count.projects", rowData.project.length) : <>{rowData.project.length} project(s)</>}
        </div>
      ),
    },
    {
      key: "Format",
      content: ppmText("ui.export.format", "Format"),
      tdRender: (rowData: RowData) => (
        <span className="text-13">
          {rowData.provider === "csv"
            ? "CSV"
            : rowData.provider === "xlsx"
              ? "Excel"
              : rowData.provider === "json"
                ? "JSON"
                : ""}
        </span>
      ),
    },
    {
      key: "Status",
      content: ppmText("ui.export.status", "Status"),
      tdRender: (rowData: RowData) => (
        <span
          className={`rounded-sm px-2 py-1 text-11 capitalize ${
            rowData.status === "completed"
              ? "bg-success-subtle text-success-primary"
              : rowData.status === "processing"
                ? "bg-yellow-500/20 text-yellow-500"
                : rowData.status === "failed"
                  ? "bg-danger-subtle text-danger-primary"
                  : rowData.status === "expired"
                    ? "bg-orange-500/20 text-orange-500"
                    : "bg-gray-500/20 text-gray-500"
          }`}
        >
          {exportStatus(rowData.status)}
        </span>
      ),
    },
    {
      key: "Download",
      content: ppmText("ui.export.download", "Download"),
      tdRender: (rowData: RowData) =>
        checkExpiry(rowData.created_at) ? (
          <>
            {rowData.status == "completed" ? (
              <a target="_blank" href={rowData?.url} rel="noopener noreferrer">
                <button className="flex w-full items-center gap-1 font-medium text-accent-primary">
                  <Download className="h-4 w-4" />
                  <div>{ppmText("ui.export.download", "Download")}</div>
                </button>
              </a>
            ) : (
              "-"
            )}
          </>
        ) : (
          <div className="text-11 text-danger-primary">{ppmText("ui.export.expired", "Expired")}</div>
        ),
    },
  ];
  return columns;
};
