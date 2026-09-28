"""G2.1 A2 (решение контроллера) — Git-объекты нашего Git-сервера на Холсте.

«На холст» и пакетная привязка живой карты работают для провайдера `forgejo` так же, как для GitHub: проекция несёт
`display.provider = "forgejo"`, версия источника укладывается в 64 символа привязки, права — те же.
"""

import uuid

import pytest
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBindingStatus
from plane.ppm_git.models import PpmGitInstallation, PpmGitObject, PpmGitRepository, PpmGitConnection
from plane.ppm_git.provider_services import connect_forgejo_repository, synchronize_connection
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def canvas_project(forgejo):
    marker = uuid.uuid4().hex
    lead = UserFactory(username=f"canvas-{marker}", email=f"canvas-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="KEY")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    guest = UserFactory(username=f"guest-{marker}", email=f"guest-{marker}@plane.test")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    state = State.objects.create(
        name="Backlog", color="#60646C", group="backlog", default=True, project=project, created_by=lead
    )
    for number in range(1, 6):
        Issue(name=f"Задача {number}", project=project, state=state).save(created_by_id=lead.id)
    _, connection = connect_forgejo_repository(
        workspace_id=workspace.id, project_id=project.id, provider_repository_id=1, user_id=lead.id
    )
    synchronize_connection(connection.id)
    github = github_pull_request(workspace, project, lead)
    return lead, guest, workspace, project, connection, github


def github_pull_request(workspace, project, user):
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider="github",
        provider_installation_id=81001,
        provider_account_id=71001,
        account_login="ppm-test-org",
        created_by=user.id,
        updated_by=user.id,
    )
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="github",
        normalized_name="github",
        provider="github",
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        canonical_url="https://github.com/ppm-test-org/ppm",
        clone_https="https://github.com/ppm-test-org/ppm.git",
        created_by=user.id,
        updated_by=user.id,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        created_by=user.id,
        updated_by=user.id,
    )
    return PpmGitObject.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        connection=connection,
        repository=repository,
        object_type="pull_request",
        provider_object_id="92001",
        ref="7",
        title="KEY-1 — GitHub PR",
        canonical_url="https://github.com/ppm-test-org/ppm/pull/7",
        state="open",
        source_version="PR_kwDOGitHubNodeId",
    )


def project_path(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}"


def forgejo_object(connection, object_type, **filters):
    return PpmGitObject.objects.get(connection=connection, object_type=object_type, **filters)


def test_a_git_server_pull_request_goes_on_the_canvas(api_client, canvas_project):
    lead, guest, workspace, project, connection, github = canvas_project
    merged = forgejo_object(connection, "pull_request", ref="1")
    api_client.force_authenticate(user=lead)

    bound = api_client.post(
        f"{project_path(workspace, project)}/canvas/bindings/",
        {
            "shape_id": "shape:forgejo-pr",
            "entity_type": "pull_request",
            "entity_id": str(merged.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    github_bound = api_client.post(
        f"{project_path(workspace, project)}/canvas/bindings/",
        {
            "shape_id": "shape:github-pr",
            "entity_type": "pull_request",
            "entity_id": str(github.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    projection = api_client.get(f"{project_path(workspace, project)}/projections/pull_request/{merged.id}/")

    assert bound.status_code == status.HTTP_201_CREATED
    source = bound.data["source"]
    assert source["display"]["provider"] == "forgejo"
    assert source["display"]["repository_name"] == "team-alpha/app"
    assert (source["display"]["state"], source["display"]["head_ref"]) == ("merged", "KEY-2/login-form")
    assert source["display"]["work_items"][0]["identifier"].startswith("KEY-")
    assert source["identity"]["source_url"] == merged.canonical_url
    assert source["source_version"] == "pr:1:2026-09-28T13:21:05+00:00"
    binding = PpmCanvasBinding.objects.get(id=bound.data["binding_id"])
    assert binding.source_version == "pr:1:2026-09-28T13:21:05+00:00" and len(binding.source_version) <= 64
    # GitHub keeps its own label and node id.
    assert github_bound.status_code == status.HTTP_201_CREATED
    assert (github_bound.data["source"]["display"]["provider"], github_bound.data["source"]["source_version"]) == (
        "github",
        "PR_kwDOGitHubNodeId",
    )
    assert projection.status_code == status.HTTP_200_OK
    assert projection.data["display"]["provider"] == "forgejo"


def test_the_living_map_binds_git_server_objects_in_one_batch(api_client, canvas_project):
    lead, guest, workspace, project, connection, _ = canvas_project
    branch = forgejo_object(connection, "branch", provider_object_id="KEY-4/docs")
    commit = forgejo_object(connection, "commit", title="KEY-4: документация датчика")
    opened = forgejo_object(connection, "pull_request", ref="3")
    api_client.force_authenticate(user=lead)
    boards = api_client.get(f"{project_path(workspace, project)}/canvas/boards/")
    board_id = boards.data["default_board_id"]
    items = [
        {"shape_id": "shape:branch", "entity_type": "branch", "entity_id": str(branch.id)},
        {"shape_id": "shape:commit", "entity_type": "commit", "entity_id": str(commit.id)},
        {"shape_id": "shape:pr", "entity_type": "pull_request", "entity_id": str(opened.id)},
        {"shape_id": "shape:repository", "entity_type": "repository", "entity_id": str(connection.repository_id)},
    ]

    response = api_client.post(
        f"{project_path(workspace, project)}/canvas/boards/{board_id}/bindings/batch/", {"items": items}, format="json"
    )
    replay = api_client.post(
        f"{project_path(workspace, project)}/canvas/boards/{board_id}/bindings/batch/", {"items": items}, format="json"
    )

    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    assert [result["status"] for result in results] == ["created"] * 4
    assert {result["binding"]["source"]["display"]["provider"] for result in results} == {"forgejo"}
    versions = [result["binding"]["source_version"] for result in results]
    assert versions[:2] == [branch.source_version, commit.source_version]
    assert versions[2].startswith("pr:3:")
    assert all(len(value) <= 64 for value in versions)
    assert [result["binding"]["idempotent_replay"] for result in replay.data["results"]] == [True] * 4
    saved = api_client.put(
        f"{project_path(workspace, project)}/canvas/boards/{board_id}/snapshot/",
        {
            "schema_version": 2,
            "base_version": 0,
            "snapshot": {
                "document": {
                    "store": {
                        item["shape_id"]: {"id": item["shape_id"], "typeName": "shape", "type": "ppm-canvas-node"}
                        for item in items
                    }
                }
            },
            "client_operation_id": str(uuid.uuid4()),
            "binding_changes": {"activate": [result["binding"]["binding_id"] for result in results], "remove": []},
        },
        format="json",
    )
    assert saved.status_code == status.HTTP_200_OK
    assert PpmCanvasBinding.objects.filter(board_id=board_id, status=PpmCanvasBindingStatus.ACTIVE).count() == 4

    # The same rights as for GitHub objects: a guest cannot place them.
    api_client.force_authenticate(user=guest)
    denied = api_client.post(
        f"{project_path(workspace, project)}/canvas/boards/{board_id}/bindings/batch/",
        {"items": [{"shape_id": "shape:guest", "entity_type": "branch", "entity_id": str(branch.id)}]},
        format="json",
    )
    assert denied.status_code == status.HTTP_403_FORBIDDEN
