/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { RequestHandler } from "express";
import expressWinston from "express-winston";
import { transports } from "winston";
import { loggerConfig } from "./config";

/**
 * HTTP request log: method, path, status and time only.
 * - The query string is cut off: it may carry one-time credentials (tokens of reset/invitation links, OAuth codes).
 * - `meta: false`: express-winston would otherwise attach the request's url, query and ALL headers (cookies,
 *   authorization) to every entry.
 * - The message template is fixed; request data is only interpolated as values, never compiled as a template.
 */
export function createLoggerMiddleware(stream?: NodeJS.WritableStream): RequestHandler {
  return expressWinston.logger({
    ...loggerConfig,
    transports: [stream ? new transports.Stream({ stream }) : new transports.Console()],
    meta: false,
    expressFormat: false,
    colorize: false,
    msg: '{{req.method}} {{String(req.originalUrl || req.url || "").split("?")[0]}} {{res.statusCode}} {{res.responseTime}}ms',
  });
}

export const loggerMiddleware: RequestHandler = createLoggerMiddleware();
