"""Safe operator output and failure signaling for backend preflight."""

import io
import json
from unittest.mock import Mock, patch

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings

from plane.ppm_canvas.management.commands import ppm_backend_preflight


CHECKS = (
    "check_database",
    "check_redis",
    "check_broker",
    "check_object_storage",
    "check_realtime",
)


def test_preflight_reports_only_component_statuses():
    output = io.StringIO()
    with (
        patch.object(ppm_backend_preflight, "check_database"),
        patch.object(ppm_backend_preflight, "check_redis"),
        patch.object(ppm_backend_preflight, "check_broker"),
        patch.object(ppm_backend_preflight, "check_object_storage"),
        patch.object(ppm_backend_preflight, "check_realtime"),
    ):
        call_command("ppm_backend_preflight", stdout=output)

    assert json.loads(output.getvalue()) == {
        "status": "ok",
        "checks": {
            "database": "ok",
            "redis": "ok",
            "broker": "ok",
            "object_storage": "ok",
            "realtime": "ok",
        },
    }


@pytest.mark.parametrize("failed_check", CHECKS)
def test_preflight_fails_without_leaking_provider_exception(failed_check):
    output = io.StringIO()
    secret = "credential-that-must-not-appear"
    with (
        patch.object(ppm_backend_preflight, "check_database"),
        patch.object(ppm_backend_preflight, "check_redis"),
        patch.object(ppm_backend_preflight, "check_broker"),
        patch.object(ppm_backend_preflight, "check_object_storage"),
        patch.object(ppm_backend_preflight, "check_realtime"),
        patch.object(ppm_backend_preflight, failed_check, side_effect=RuntimeError(secret)),
        pytest.raises(CommandError) as error,
    ):
        call_command("ppm_backend_preflight", stdout=output)

    response = json.loads(output.getvalue())
    assert response["status"] == "fail"
    assert response["checks"][failed_check.removeprefix("check_")] == "fail"
    assert secret not in output.getvalue()
    assert secret not in str(error.value)


@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
def test_realtime_preflight_rejects_process_local_channel_layer():
    with pytest.raises(RuntimeError, match="shared Redis"):
        ppm_backend_preflight.check_realtime()


def test_storage_write_probe_round_trips_and_removes_versioned_object():
    client = Mock()
    client.put_object.return_value = {"VersionId": "probe-version"}
    client.get_object.side_effect = lambda **kwargs: {"Body": io.BytesIO(client.put_object.call_args.kwargs["Body"])}

    with patch.object(ppm_backend_preflight, "_object_storage_client", return_value=client):
        ppm_backend_preflight.check_object_storage_io()

    put_args = client.put_object.call_args.kwargs
    assert put_args["Key"].startswith("_ppm-preflight/")
    assert put_args["Body"]
    client.get_object.assert_called_once_with(Bucket=put_args["Bucket"], Key=put_args["Key"])
    client.delete_object.assert_called_once_with(
        Bucket=put_args["Bucket"], Key=put_args["Key"], VersionId="probe-version"
    )


def test_storage_write_probe_cleans_up_after_bad_read():
    client = Mock()
    client.put_object.return_value = {}
    client.get_object.return_value = {"Body": io.BytesIO(b"different content")}

    with (
        patch.object(ppm_backend_preflight, "_object_storage_client", return_value=client),
        pytest.raises(RuntimeError, match="did not round-trip"),
    ):
        ppm_backend_preflight.check_object_storage_io()

    put_args = client.put_object.call_args.kwargs
    client.delete_object.assert_called_once_with(Bucket=put_args["Bucket"], Key=put_args["Key"])


def test_storage_write_probe_is_opt_in_and_redacts_failure():
    output = io.StringIO()
    secret = "credential-that-must-not-appear"
    with (
        patch.object(ppm_backend_preflight, "check_database"),
        patch.object(ppm_backend_preflight, "check_redis"),
        patch.object(ppm_backend_preflight, "check_broker"),
        patch.object(ppm_backend_preflight, "check_object_storage"),
        patch.object(ppm_backend_preflight, "check_realtime"),
        patch.object(ppm_backend_preflight, "check_object_storage_io", side_effect=RuntimeError(secret)),
        pytest.raises(CommandError) as error,
    ):
        call_command("ppm_backend_preflight", verify_storage_write=True, stdout=output)

    response = json.loads(output.getvalue())
    assert response["checks"]["object_storage_io"] == "fail"
    assert secret not in output.getvalue()
    assert secret not in str(error.value)
