"""The public instance bootstrap must survive several clients behind one IP."""

import pytest
from django.core.cache import cache
from django.test import Client


@pytest.mark.django_db
def test_instance_bootstrap_uses_dedicated_bounded_rate():
    # A shared proxy IP produced a 429 after a handful of rapid sign-ins and
    # left the entire web application on its startup-error screen.
    cache.delete_pattern("throttle_ppm_instance_bootstrap_*")
    client = Client(REMOTE_ADDR="203.0.113.42")
    try:
        responses = [client.get("/api/instances/") for _ in range(300)]
        assert all(response.status_code == 200 for response in responses)
        assert client.get("/api/instances/").status_code == 429
    finally:
        cache.delete_pattern("throttle_ppm_instance_bootstrap_*")
