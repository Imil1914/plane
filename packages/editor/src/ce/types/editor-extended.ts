/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type IEditorExtensionOptions = unknown;

export type IEditorPropsExtended = unknown;

export type ICollaborativeDocumentEditorPropsExtended = unknown;

// G2.3 (line G-Web): the "/" slash-menu item «Коммит или PR» on pages needs its own `commandKey`
// (`ISlashCommandItem.commandKey: TEditorCommands`) even though it is never checked by `isMenuItemActive` — it is
// not a toolbar command, just a slash-only insertion. See `ce/extensions/g23-insert-git-object.tsx`.
export type TExtendedEditorCommands = "g23_insert_git_object";

export type TExtendedCommandExtraProps = unknown;

export type TExtendedEditorRefApi = unknown;
