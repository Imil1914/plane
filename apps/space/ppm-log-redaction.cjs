/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Preloaded by the space image (`node --require`): `react-router-serve` logs every request with morgan("tiny"),
 * whose `:url` token is the full URL including the query string — and space URLs carry one-time credentials
 * (password-reset and magic-link tokens, invitation links). The `url` token is replaced by the path without the
 * query string for every morgan instance loaded in this process. Nothing else changes.
 */
"use strict";

const Module = require("module");

function pathWithoutQuery(req) {
  const url = req.originalUrl || req.url || "";
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

function redactMorgan(morgan) {
  if (morgan && typeof morgan.token === "function" && !morgan.__ppmRedacted) {
    morgan.token("url", pathWithoutQuery);
    Object.defineProperty(morgan, "__ppmRedacted", { value: true });
  }
  return morgan;
}

const originalLoad = Module._load;
Module._load = function ppmLoad(request, ...rest) {
  const exported = originalLoad.call(this, request, ...rest);
  return request === "morgan" ? redactMorgan(exported) : exported;
};

module.exports = { pathWithoutQuery, redactMorgan };
