/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// helpers
import { editorText } from "@/helpers/ppm-text";

export enum EFileError {
  INVALID_FILE_TYPE = "INVALID_FILE_TYPE",
  FILE_SIZE_TOO_LARGE = "FILE_SIZE_TOO_LARGE",
  NO_FILE_SELECTED = "NO_FILE_SELECTED",
}

type TArgs = {
  acceptedMimeTypes: string[];
  file: File;
  maxFileSize: number;
  onError: (error: EFileError, message: string) => void;
};

export const isFileValid = (args: TArgs): boolean => {
  const { acceptedMimeTypes, file, maxFileSize, onError } = args;

  if (!file) {
    onError(
      EFileError.NO_FILE_SELECTED,
      editorText("ui.editor.file_missing", "No file selected. Please select a file to upload.")
    );
    return false;
  }

  if (!acceptedMimeTypes.includes(file.type)) {
    onError(EFileError.INVALID_FILE_TYPE, editorText("ui.editor.file_type", "Invalid file type."));
    return false;
  }

  if (file.size > maxFileSize) {
    const size = maxFileSize / 1024 / 1024;
    onError(
      EFileError.FILE_SIZE_TOO_LARGE,
      editorText("ui.editor.file_too_large", `File size too large. Please select a file smaller than ${size}MB.`, {
        size,
      })
    );
    return false;
  }

  return true;
};
