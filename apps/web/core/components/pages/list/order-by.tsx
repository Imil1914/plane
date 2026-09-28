/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ArrowDownWideNarrow, ArrowUpWideNarrow } from "lucide-react";
// plane imports
import { getButtonStyling } from "@plane/propel/button";
// types
import { CheckIcon } from "@plane/propel/icons";
import type { TPageFiltersSortBy, TPageFiltersSortKey } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { usePpmText } from "@/hooks/use-ppm-text";
import type { TPpmTranslationKey } from "@ppm/brand";

type Props = {
  onChange: (value: { key?: TPageFiltersSortKey; order?: TPageFiltersSortBy }) => void;
  sortBy: TPageFiltersSortBy;
  sortKey: TPageFiltersSortKey;
};

const PAGE_SORTING_KEY_OPTIONS: {
  key: TPageFiltersSortKey;
  label: string;
}[] = [
  { key: "name", label: "Name" },
  { key: "created_at", label: "Date created" },
  { key: "updated_at", label: "Date modified" },
];

// PPM names of the sort keys (the labels above stay the upstream fallback).
const PAGE_SORTING_KEY_LABELS: Partial<Record<TPageFiltersSortKey, TPpmTranslationKey>> = {
  name: "ui.page.sort_name",
  created_at: "ui.page.sort_created",
  updated_at: "ui.page.sort_updated",
};

export function PageOrderByDropdown(props: Props) {
  const { onChange, sortBy, sortKey } = props;
  const ppmText = usePpmText();
  const sortLabel = (option: { key: TPageFiltersSortKey; label: string }) => {
    const key = PAGE_SORTING_KEY_LABELS[option.key];
    return key ? ppmText(key, option.label) : option.label;
  };

  const orderByDetails = PAGE_SORTING_KEY_OPTIONS.find((option) => sortKey === option.key);
  const isDescending = sortBy === "desc";

  return (
    <CustomMenu
      customButton={
        <div className={getButtonStyling("secondary", "lg")}>
          {!isDescending ? <ArrowUpWideNarrow className="size-3" /> : <ArrowDownWideNarrow className="size-3" />}
          {orderByDetails ? sortLabel(orderByDetails) : undefined}
        </div>
      }
      placement="bottom-end"
      maxHeight="lg"
      closeOnSelect
    >
      {PAGE_SORTING_KEY_OPTIONS.map((option) => (
        <CustomMenu.MenuItem
          key={option.key}
          className="flex items-center justify-between gap-2"
          onClick={() =>
            onChange({
              key: option.key,
            })
          }
        >
          {sortLabel(option)}
          {sortKey === option.key && <CheckIcon className="h-3 w-3" />}
        </CustomMenu.MenuItem>
      ))}
      <hr className="my-2 border-subtle" />
      <CustomMenu.MenuItem
        className="flex items-center justify-between gap-2"
        onClick={() => {
          if (isDescending)
            onChange({
              order: "asc",
            });
        }}
      >
        {ppmText("ui.sort.ascending", "Ascending")}
        {!isDescending && <CheckIcon className="h-3 w-3" />}
      </CustomMenu.MenuItem>
      <CustomMenu.MenuItem
        className="flex items-center justify-between gap-2"
        onClick={() => {
          if (!isDescending)
            onChange({
              order: "desc",
            });
        }}
      >
        {ppmText("ui.sort.descending", "Descending")}
        {isDescending && <CheckIcon className="h-3 w-3" />}
      </CustomMenu.MenuItem>
    </CustomMenu>
  );
}
