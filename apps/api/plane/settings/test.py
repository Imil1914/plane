# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Test Settings"""

import os

from .common import *  # noqa

DEBUG = True
PPM_LOCAL_ASSET_UPLOADS = os.environ.get("PPM_LOCAL_ASSET_UPLOADS", "0") == "1"
PPM_AGENT_TASK_ALWAYS_EAGER = True
PPM_AGENT_LEASE_SECONDS = 60
PPM_AGENT_MAX_ATTEMPTS = 3

# Send it in a dummy outbox
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

INSTALLED_APPS.append(  # noqa
    "plane.tests"
)
