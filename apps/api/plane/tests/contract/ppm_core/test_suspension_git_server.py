"""G2.2 R15/R15a — отключение в центре администратора доходит до Git-сервера.

Сохранение пользователя с ``is_active`` — сигнал линии S2a ставит сверку по человеку (после коммита, ≈5 с); сверка
на поддельном Forgejo 15 запрещает вход (``prohibit_login``) и убирает из команд PPM; «Включить» — возвращает вход и
доступы. Токены, выданные Git-серверу при входе через PPM, удаляет сигнал линии S1 (отдельный модуль с библиотекой
OAuth2 — ``test_suspension_git_server_tokens.py``).
"""

import uuid

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git import forgejo_access
from plane.ppm_git.forgejo_access import apply_user_access, ensure_account_for_login, run_access_sync
from plane.ppm_git.forgejo_admin import ForgejoAdminClient
from plane.tests.contract.ppm_git.forgejo_admin_fake import SSO_SETTINGS, FakeForgejoAdminApi
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def forgejo(settings, monkeypatch):
    api = FakeForgejoAdminApi()
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    monkeypatch.setattr(
        forgejo_access, "ForgejoAdminClient", lambda: ForgejoAdminClient(session=api, page_size=api.page_size)
    )
    # The delayed task itself is not queued in tests: the pending scope is run by hand below.
    monkeypatch.setattr("plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: None)
    forgejo_access.clear_access_cache()
    yield api
    forgejo_access.clear_access_cache()


def person(email):
    return UserFactory(email=email, username=uuid.uuid4().hex, display_name=email.split("@")[0].title())


@pytest.fixture
def developer(forgejo):
    """A project member who has already signed in to the Git server through PPM (account + team «APP»)."""
    workspace = WorkspaceFactory(slug="team-alpha", name="Команда Альфа", owner=person("owner@example.test"))
    project = ProjectFactory(workspace=workspace, identifier="APP", name="Приложение")
    dev = person("dev@example.test")
    WorkspaceMemberFactory(workspace=workspace, member=dev, role=15)
    ProjectMemberFactory(project=project, member=dev, role=15)
    ensure_account_for_login(dev)
    assert apply_user_access(dev) is True
    assert forgejo.members(forgejo.team("team-alpha", "APP")) == ["dev"]
    return dev


@pytest.fixture
def admin_api(db):
    admin = person("admin@example.test")
    PpmGlobalAdmin.objects.create(user=admin, reason="Владелец PPM")
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


def test_switching_off_locks_the_person_out_of_the_git_server_and_back_in(
    forgejo, developer, admin_api, django_capture_on_commit_callbacks
):
    forgejo_access.clear_access_cache()
    with django_capture_on_commit_callbacks(execute=True):
        response = admin_api.post(f"/api/ppm/v1/admin/users/{developer.id}/suspend/")
    assert response.status_code == status.HTTP_200_OK

    assert forgejo_access.pending_scope()["user_ids"] == [str(developer.id)]
    run_access_sync()
    assert forgejo.user("dev")["prohibit_login"] is True
    assert forgejo.members(forgejo.team("team-alpha", "APP")) == []

    with django_capture_on_commit_callbacks(execute=True):
        response = admin_api.post(f"/api/ppm/v1/admin/users/{developer.id}/resume/")
    assert response.status_code == status.HTTP_200_OK

    assert forgejo_access.pending_scope()["user_ids"] == [str(developer.id)]
    run_access_sync()
    assert forgejo.user("dev")["prohibit_login"] is False
    assert forgejo.members(forgejo.team("team-alpha", "APP")) == ["dev"]
