/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// extensions
import type { TSlashCommandAdditionalOption } from "@/extensions";
// types
import type { IEditorProps } from "@/types";
// G2.3 (line G-Web): «Коммит или PR» — see g23-insert-git-object.tsx for why this needs a host-registered handler.
import { createG23InsertGitObjectSlashOption } from "./g23-insert-git-object";
// Review round 1 (#1): only offer the item while some host has actually registered a handler (currently only
// pages/editor/editor-body.tsx does) — otherwise selecting it in an editor with no host (e.g. a task description)
// silently deletes "/query" and inserts nothing.
import { hasG23InsertGitObjectHandler } from "./g23-insert-git-object-bridge";

type Props = Pick<IEditorProps, "disabledExtensions" | "flaggedExtensions">;

export const coreEditorAdditionalSlashCommandOptions = (props: Props): TSlashCommandAdditionalOption[] => {
  const {} = props;
  const options: TSlashCommandAdditionalOption[] = [];
  if (hasG23InsertGitObjectHandler()) options.push(createG23InsertGitObjectSlashOption());
  return options;
};
