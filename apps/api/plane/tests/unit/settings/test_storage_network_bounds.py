# Copyright (c) 2026 PPM contributors
# SPDX-License-Identifier: AGPL-3.0-only

"""S3 clients must fail fast when object storage is unreachable.

RC-6 failure injection: with MinIO down, one Vault upload waited ~310 s (botocore defaults: 60 s read timeout,
legacy retries), holding the API worker's synchronous thread. Every client built by ``S3Storage`` now carries
bounded connect/read timeouts and a bounded number of attempts (tunable through the environment).
"""

import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from plane.settings.storage import S3Storage


BASE_ENV = {
    "AWS_S3_BUCKET_NAME": "uploads",
    "AWS_ACCESS_KEY_ID": "test-access-key",
    "AWS_SECRET_ACCESS_KEY": "test-secret-key",
    "AWS_S3_ENDPOINT_URL": "https://ppm.example.test",
    "AWS_REGION": "us-east-1",
}
BROWSER_REQUEST = SimpleNamespace(scheme="https", get_host=lambda: "ppm.example.test")


def client_configs():
    return [S3Storage().s3_client.meta.config, S3Storage(request=BROWSER_REQUEST).s3_client.meta.config]


@pytest.mark.unit
@pytest.mark.parametrize("use_minio", ["1", "0"])
def test_every_s3_client_has_bounded_timeouts_and_attempts(use_minio):
    with patch.dict(os.environ, {**BASE_ENV, "USE_MINIO": use_minio}, clear=True):
        for config in client_configs():
            assert config.connect_timeout == 5
            assert config.read_timeout == 10
            assert config.retries["mode"] == "standard"
            assert config.retries["total_max_attempts"] == 2
            assert config.signature_version == "s3v4"


@pytest.mark.unit
def test_network_bounds_can_be_tuned_by_the_operator():
    tuned = {"AWS_S3_CONNECT_TIMEOUT": "2", "AWS_S3_READ_TIMEOUT": "30", "AWS_S3_MAX_ATTEMPTS": "3"}
    with patch.dict(os.environ, {**BASE_ENV, "USE_MINIO": "1", **tuned}, clear=True):
        for config in client_configs():
            assert (config.connect_timeout, config.read_timeout) == (2, 30)
            assert config.retries["total_max_attempts"] == 3


@pytest.mark.unit
@pytest.mark.parametrize("bad_value", ["0", "-1", "abc", ""])
def test_invalid_tuning_values_fall_back_to_safe_defaults(bad_value):
    tuned = {"AWS_S3_CONNECT_TIMEOUT": bad_value, "AWS_S3_READ_TIMEOUT": bad_value, "AWS_S3_MAX_ATTEMPTS": bad_value}
    with patch.dict(os.environ, {**BASE_ENV, "USE_MINIO": "1", **tuned}, clear=True):
        config = S3Storage().s3_client.meta.config
        assert (config.connect_timeout, config.read_timeout, config.retries["total_max_attempts"]) == (5, 10, 2)
