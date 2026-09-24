import uuid
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import FileAsset, Issue, Page, ProjectPage, State
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasVersion
from plane.ppm_git.models import (
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitObject,
    PpmGitRepository,
)
from plane.ppm_vault.services import create_markdown, get_or_create_project_vault, update_markdown
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user():
    marker = uuid.uuid4().hex
    return UserFactory(username=f"projection-{marker}", email=f"projection-{marker}@plane.test")


@pytest.fixture
def projection_project():
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="MAP")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=user,
    )
    return user, workspace, project, state


def authenticate(api_client, user):
    api_client.force_authenticate(user=user)


def create_issue(project, state, user, name="Mapped issue"):
    issue = Issue(name=name, project=project, state=state)
    issue.save(created_by_id=user.id)
    return issue


def project_path(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}"


def bindings_url(workspace, project):
    return f"{project_path(workspace, project)}/canvas/bindings/"


def canvas_url(workspace, project):
    return f"{project_path(workspace, project)}/canvas/"


def canvas_snapshot(*shape_ids):
    return {
        "document": {
            "store": {
                shape_id: {"id": shape_id, "typeName": "shape", "type": "ppm-canvas-node"} for shape_id in shape_ids
            }
        }
    }


def save_canvas(
    api_client, workspace, project, *, base_version, shape_ids=(), activate=(), remove=(), operation_id=None
):
    return api_client.put(
        canvas_url(workspace, project),
        {
            "schema_version": 2,
            "base_version": base_version,
            "snapshot": canvas_snapshot(*shape_ids),
            "client_operation_id": str(operation_id or uuid.uuid4()),
            "binding_changes": {
                "activate": [str(binding_id) for binding_id in activate],
                "remove": [str(binding_id) for binding_id in remove],
            },
        },
        format="json",
    )


def activate_binding(api_client, workspace, project, binding_response, *, base_version=0, retained_shape_ids=()):
    shape_id = binding_response.data["shape_id"]
    return save_canvas(
        api_client,
        workspace,
        project,
        base_version=base_version,
        shape_ids=(*retained_shape_ids, shape_id),
        activate=[binding_response.data["binding_id"]],
    )


def bind_payload(issue, *, shape_id="shape:first", operation_id=None):
    return {
        "shape_id": shape_id,
        "entity_type": "work_item",
        "entity_id": str(issue.id),
        "client_operation_id": str(operation_id or uuid.uuid4()),
    }


def test_search_is_paginated_and_strictly_project_scoped(api_client, projection_project):
    user, workspace, project, state = projection_project
    first = create_issue(project, state, user, "Alpha map")
    second = create_issue(project, state, user, "Alpha plan")
    other_project = ProjectFactory(workspace=workspace, identifier="MAP2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=user, role=20)
    other_state = State.objects.create(
        name="Other backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=other_project,
        created_by=user,
    )
    foreign = create_issue(other_project, other_state, user, "Alpha foreign")
    authenticate(api_client, user)

    first_page = api_client.get(
        f"{project_path(workspace, project)}/projections/search/",
        {"types": "work_item", "q": "Alpha", "limit": 1},
    )
    second_page = api_client.get(
        f"{project_path(workspace, project)}/projections/search/",
        {"types": "work_item", "q": "Alpha", "limit": 1, "cursor": first_page.data["next_cursor"]},
    )

    assert first_page.status_code == status.HTTP_200_OK
    assert second_page.status_code == status.HTTP_200_OK
    ids = {
        first_page.data["results"][0]["identity"]["entity_id"],
        second_page.data["results"][0]["identity"]["entity_id"],
    }
    assert ids == {str(first.id), str(second.id)}
    assert str(foreign.id) not in ids
    assert second_page.data["next_cursor"] is None


def test_guest_search_keeps_native_created_by_restriction(api_client, projection_project):
    owner, workspace, project, state = projection_project
    guest = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    owner_issue = create_issue(project, state, owner, "Owner only")
    guest_issue = create_issue(project, state, guest, "Guest own")
    authenticate(api_client, guest)

    response = api_client.get(f"{project_path(workspace, project)}/projections/search/")

    assert response.status_code == status.HTTP_200_OK
    ids = {item["identity"]["entity_id"] for item in response.data["results"]}
    assert str(guest_issue.id) in ids
    assert str(owner_issue.id) not in ids


def test_binding_rejects_foreign_source_and_allows_two_shapes_for_one_item(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    foreign_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_state = State.objects.create(
        name="Foreign backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=foreign_project,
        created_by=user,
    )
    foreign_issue = create_issue(foreign_project, foreign_state, user)
    authenticate(api_client, user)

    denied = api_client.post(bindings_url(workspace, project), bind_payload(foreign_issue), format="json")
    denied_resolve = api_client.get(f"{project_path(workspace, project)}/projections/work_item/{foreign_issue.id}/")
    first = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    second = api_client.post(
        bindings_url(workspace, project),
        bind_payload(issue, shape_id="shape:second"),
        format="json",
    )

    assert denied.status_code == status.HTTP_404_NOT_FOUND
    assert denied.data["error"]["code"] == "WORK_ITEM_NOT_FOUND"
    assert denied_resolve.status_code == status.HTTP_404_NOT_FOUND
    assert denied_resolve.data["error"]["code"] == "WORK_ITEM_NOT_FOUND"
    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_201_CREATED
    assert first.data["binding_status"] == "pending"
    assert first.data["source"]["identity"]["source_url"] == (
        f"/{workspace.slug}/browse/{project.identifier}-{issue.sequence_id}/"
    )
    assert PpmCanvasBinding.objects.filter(project_id=project.id, entity_id=issue.id).count() == 2


def test_content_bindings_resolve_live_project_sources_and_reject_foreign_ids(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    page = Page.objects.create(workspace=workspace, owned_by=user, name="Project brief", description_html="<p>Goal</p>")
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    attachment = FileAsset.objects.create(
        attributes={"name": "map.png", "type": "image/png", "size": 12},
        asset="project/map.png",
        size=12,
        workspace=workspace,
        project=project,
        issue=issue,
        user=user,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
        created_by=user,
    )
    vault = get_or_create_project_vault(workspace_id=workspace.id, project_id=project.id, user_id=user.id)
    vault_entry = create_markdown(
        vault=vault,
        parent_id=None,
        name="Context.md",
        content="# Version one",
        user_id=user.id,
    )
    foreign_project = ProjectFactory(workspace=workspace, identifier="OTHER")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_vault = get_or_create_project_vault(
        workspace_id=workspace.id,
        project_id=foreign_project.id,
        user_id=user.id,
    )
    foreign_entry = create_markdown(
        vault=foreign_vault,
        parent_id=None,
        name="Foreign.md",
        content="foreign",
        user_id=user.id,
    )
    authenticate(api_client, user)

    created = []
    for index, (entity_type, entity_id) in enumerate(
        (("page", page.id), ("attachment", attachment.id), ("vault_file", vault_entry.id))
    ):
        created.append(
            api_client.post(
                bindings_url(workspace, project),
                {
                    "shape_id": f"shape:content-{index}",
                    "entity_type": entity_type,
                    "entity_id": str(entity_id),
                    "client_operation_id": str(uuid.uuid4()),
                },
                format="json",
            )
        )
    denied = api_client.post(
        bindings_url(workspace, project),
        {
            "shape_id": "shape:foreign",
            "entity_type": "vault_file",
            "entity_id": str(foreign_entry.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )

    assert [response.status_code for response in created] == [201, 201, 201]
    assert created[0].data["source"]["display"]["excerpt"] == "Goal"
    assert created[1].data["source"]["display"]["mime_type"] == "image/png"
    assert created[2].data["source"]["source_version"] == "1"
    assert denied.status_code == status.HTTP_404_NOT_FOUND
    assert denied.data["error"]["code"] == "CONTENT_SOURCE_NOT_FOUND"

    update_markdown(entry=vault_entry, base_version=1, content="# Version two", user_id=user.id)
    detail = api_client.get(f"{project_path(workspace, project)}/projections/vault_file/{vault_entry.id}/")
    assert detail.status_code == status.HTTP_200_OK
    assert detail.data["source_version"] == "2"
    assert detail.data["display"]["excerpt"] == "# Version two"


def test_git_bindings_are_live_project_scoped_projections(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user, "Ship Git projection")
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="PPM",
        normalized_name="ppm",
        provider="github",
        provider_repository_id=101,
        provider_full_name="ppm/ppm",
        canonical_url="https://github.com/ppm/ppm",
        clone_https="https://github.com/ppm/ppm.git",
        clone_ssh="git@github.com:ppm/ppm.git",
        default_branch="main",
        visibility="private",
        is_default=True,
        created_by=user.id,
        updated_by=user.id,
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=201,
        provider_account_id=301,
        account_login="ppm",
        created_by=user.id,
        updated_by=user.id,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=101,
        provider_full_name="ppm/ppm",
        created_by=user.id,
        updated_by=user.id,
    )
    git_object = PpmGitObject.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        connection=connection,
        repository=repository,
        object_type="commit",
        provider_object_id="abc123",
        ref="abc123",
        title="MAP-1: initial projection",
        canonical_url="https://github.com/ppm/ppm/commit/abc123",
        author_name="PPM Bot",
        commit_sha="abc123",
        source_version="abc123:v1",
    )
    PpmGitLink.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        repository=repository,
        git_object=git_object,
        work_item=issue,
        object_type="commit",
        ref="abc123",
        title=git_object.title,
        canonical_url=git_object.canonical_url,
        origin=PpmGitLinkOrigin.PROVIDER,
        created_by=user.id,
        updated_by=user.id,
    )
    foreign_project = ProjectFactory(workspace=workspace, identifier="GITOUT")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=foreign_project.id,
        name="Foreign",
        normalized_name="foreign",
        provider="github",
        canonical_url="https://github.com/ppm/foreign",
        clone_https="https://github.com/ppm/foreign.git",
        created_by=user.id,
        updated_by=user.id,
    )
    authenticate(api_client, user)

    repository_binding = api_client.post(
        bindings_url(workspace, project),
        {
            "shape_id": "shape:git-repository",
            "entity_type": "repository",
            "entity_id": str(repository.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    commit_binding = api_client.post(
        bindings_url(workspace, project),
        {
            "shape_id": "shape:git-commit",
            "entity_type": "commit",
            "entity_id": str(git_object.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    denied = api_client.post(
        bindings_url(workspace, project),
        {
            "shape_id": "shape:git-foreign",
            "entity_type": "repository",
            "entity_id": str(foreign_repository.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )

    assert repository_binding.status_code == status.HTTP_201_CREATED
    assert repository_binding.data["source"]["display"]["repository_name"] == "ppm/ppm"
    assert commit_binding.status_code == status.HTTP_201_CREATED
    assert commit_binding.data["source"]["display"]["commit_sha"] == "abc123"
    assert commit_binding.data["source"]["display"]["work_items"][0]["identifier"].startswith("MAP-")
    assert denied.status_code == status.HTTP_404_NOT_FOUND
    assert denied.data["error"]["code"] == "GIT_SOURCE_NOT_FOUND"

    activated = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        shape_ids=[repository_binding.data["shape_id"], commit_binding.data["shape_id"]],
        activate=[repository_binding.data["binding_id"], commit_binding.data["binding_id"]],
    )
    git_object.title = "MAP-1: updated by provider"
    git_object.source_version = "abc123:v2"
    git_object.save(update_fields=["title", "source_version", "last_seen_at"])
    refreshed = api_client.get(bindings_url(workspace, project))

    assert activated.status_code == status.HTTP_200_OK
    live_commit = next(item for item in refreshed.data["bindings"] if item["entity_type"] == "commit")
    assert live_commit["source"]["display"]["title"] == "MAP-1: updated by provider"
    assert live_commit["source_version"] == "abc123:v2"

    removed = save_canvas(
        api_client,
        workspace,
        project,
        base_version=activated.data["version"],
        shape_ids=[repository_binding.data["shape_id"]],
        remove=[commit_binding.data["binding_id"]],
    )
    assert removed.status_code == status.HTTP_200_OK
    assert PpmGitObject.objects.filter(id=git_object.id).exists()
    assert PpmGitRepository.objects.filter(id=repository.id).exists()


def test_binding_retry_is_idempotent_but_changed_request_conflicts(api_client, projection_project):
    user, workspace, project, state = projection_project
    first_issue = create_issue(project, state, user, "First")
    second_issue = create_issue(project, state, user, "Second")
    operation_id = uuid.uuid4()
    payload = bind_payload(first_issue, operation_id=operation_id)
    authenticate(api_client, user)

    first = api_client.post(bindings_url(workspace, project), payload, format="json")
    replay = api_client.post(bindings_url(workspace, project), payload, format="json")
    reused = api_client.post(
        bindings_url(workspace, project),
        bind_payload(second_issue, operation_id=operation_id),
        format="json",
    )

    assert first.status_code == status.HTTP_201_CREATED
    assert replay.status_code == status.HTTP_200_OK
    assert replay.data["binding_id"] == first.data["binding_id"]
    assert replay.data["idempotent_replay"] is True
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert reused.data["error"]["code"] == "BINDING_OPERATION_REUSED"
    assert PpmCanvasBinding.objects.count() == 1


def test_shape_can_only_have_one_projection(api_client, projection_project):
    user, workspace, project, state = projection_project
    first_issue = create_issue(project, state, user, "First")
    second_issue = create_issue(project, state, user, "Second")
    authenticate(api_client, user)

    first = api_client.post(bindings_url(workspace, project), bind_payload(first_issue), format="json")
    conflict = api_client.post(bindings_url(workspace, project), bind_payload(second_issue), format="json")

    assert first.status_code == status.HTTP_201_CREATED
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "BINDING_SHAPE_CONFLICT"
    assert PpmCanvasBinding.objects.filter(project_id=project.id, shape_id="shape:first").count() == 1


def test_pending_projection_can_be_cancelled_without_deleting_plane_work_item(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")

    removed = api_client.delete(f"{bindings_url(workspace, project)}{created.data['binding_id']}/")

    assert removed.status_code == status.HTTP_204_NO_CONTENT
    assert not PpmCanvasBinding.objects.filter(id=created.data["binding_id"]).exists()
    assert Issue.objects.filter(id=issue.id).exists()


def test_active_projection_is_removed_atomically_with_canvas_snapshot(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    activated = activate_binding(api_client, workspace, project, created)

    direct_delete = api_client.delete(f"{bindings_url(workspace, project)}{created.data['binding_id']}/")
    removed = save_canvas(
        api_client,
        workspace,
        project,
        base_version=activated.data["version"],
        remove=[created.data["binding_id"]],
    )

    assert activated.status_code == status.HTTP_200_OK
    assert direct_delete.status_code == status.HTTP_409_CONFLICT
    assert direct_delete.data["error"]["code"] == "BINDING_ACTIVE_REQUIRES_CANVAS_SAVE"
    assert removed.status_code == status.HTTP_200_OK
    assert not PpmCanvasBinding.objects.filter(id=created.data["binding_id"]).exists()
    assert Issue.objects.filter(id=issue.id).exists()
    assert api_client.get(bindings_url(workspace, project)).data["bindings"] == []


def test_deleted_source_remains_an_understandable_binding_state(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    activate_binding(api_client, workspace, project, created)
    with patch("plane.db.mixins.soft_delete_related_objects"):
        issue.delete()

    response = api_client.get(bindings_url(workspace, project))

    assert response.status_code == status.HTTP_200_OK
    source = response.data["bindings"][0]["source"]
    assert response.data["bindings"][0]["binding_status"] == "active"
    assert source["display"]["source_status"] == "deleted"
    assert source["display"]["title"] == "Mapped issue"
    assert source["capabilities"]["update"] is False


def test_archived_source_is_visible_but_read_only(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    activate_binding(api_client, workspace, project, created)
    issue.archived_at = timezone.now()
    issue.save(update_fields=["archived_at", "updated_at"])

    response = api_client.get(bindings_url(workspace, project))

    assert response.status_code == status.HTTP_200_OK
    source = response.data["bindings"][0]["source"]
    assert source["display"]["source_status"] == "archived"
    assert source["identity"]["source_url"].endswith(f"/archives/issues/{issue.id}")
    assert source["capabilities"]["update"] is False


def test_binding_refresh_reads_current_plane_data(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    activate_binding(api_client, workspace, project, created)
    original_version = created.data["source_version"]
    issue.name = "Updated outside Canvas"
    issue.save(update_fields=["name", "updated_at"])

    response = api_client.get(bindings_url(workspace, project))

    assert response.status_code == status.HTTP_200_OK
    binding = response.data["bindings"][0]
    assert binding["source"]["display"]["title"] == "Updated outside Canvas"
    assert binding["source_version"] != original_version


def test_failed_activation_never_exposes_binding_or_advances_canvas(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")

    failed = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        activate=[created.data["binding_id"]],
    )
    bindings = api_client.get(bindings_url(workspace, project))

    assert failed.status_code == status.HTTP_409_CONFLICT
    assert failed.data["error"]["code"] == "CANVAS_BINDING_SHAPE_MISSING"
    assert PpmCanvasVersion.objects.count() == 0
    assert PpmCanvasBinding.objects.get(id=created.data["binding_id"]).status == PpmCanvasBindingStatus.PENDING
    assert bindings.data["bindings"] == []


def test_stale_activation_rolls_back_binding_change(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    first_save = save_canvas(api_client, workspace, project, base_version=0)

    stale = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        shape_ids=[created.data["shape_id"]],
        activate=[created.data["binding_id"]],
    )

    assert first_save.status_code == status.HTTP_200_OK
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "CANVAS_VERSION_CONFLICT"
    assert PpmCanvasVersion.objects.count() == 1
    assert PpmCanvasBinding.objects.get(id=created.data["binding_id"]).status == PpmCanvasBindingStatus.PENDING


def test_failed_removal_keeps_snapshot_and_active_binding(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    activated = activate_binding(api_client, workspace, project, created)

    failed = save_canvas(
        api_client,
        workspace,
        project,
        base_version=activated.data["version"],
        shape_ids=[created.data["shape_id"]],
        remove=[created.data["binding_id"]],
    )

    assert failed.status_code == status.HTTP_409_CONFLICT
    assert failed.data["error"]["code"] == "CANVAS_BINDING_SHAPE_PRESENT"
    assert PpmCanvasVersion.objects.count() == 1
    assert PpmCanvasBinding.objects.get(id=created.data["binding_id"]).status == PpmCanvasBindingStatus.ACTIVE


def test_canvas_save_operation_id_covers_binding_changes(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    authenticate(api_client, user)
    created = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    operation_id = uuid.uuid4()
    save = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        shape_ids=[created.data["shape_id"]],
        activate=[created.data["binding_id"]],
        operation_id=operation_id,
    )
    replay = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        shape_ids=[created.data["shape_id"]],
        activate=[created.data["binding_id"]],
        operation_id=operation_id,
    )
    reused = save_canvas(
        api_client,
        workspace,
        project,
        base_version=0,
        shape_ids=[created.data["shape_id"]],
        operation_id=operation_id,
    )

    assert save.status_code == status.HTTP_200_OK
    assert replay.status_code == status.HTTP_200_OK
    assert replay.data["idempotent_replay"] is True
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert reused.data["error"]["code"] == "CANVAS_OPERATION_REUSED"
    assert PpmCanvasVersion.objects.count() == 1


def test_quick_edit_uses_source_precondition_and_updates_native_plane_item(api_client, projection_project):
    user, workspace, project, state = projection_project
    issue = create_issue(project, state, user)
    next_state = State.objects.create(
        name="In progress",
        color="#F59E0B",
        group="started",
        project=project,
        created_by=user,
    )
    authenticate(api_client, user)
    detail_url = f"{project_path(workspace, project)}/projections/work_item/{issue.id}/"
    source = api_client.get(detail_url).data
    update_url = f"{project_path(workspace, project)}/work-items/{issue.id}/"

    with (
        patch("plane.ppm_canvas.views.issue_activity") as activity,
        patch("plane.ppm_canvas.views.model_activity"),
    ):
        updated = api_client.patch(
            update_url,
            {
                "source_version": source["source_version"],
                "state_id": str(next_state.id),
                "priority": "high",
                "due_date": "2026-09-30",
            },
            format="json",
        )

    assert updated.status_code == status.HTTP_200_OK
    issue.refresh_from_db()
    assert issue.state_id == next_state.id
    assert issue.priority == "high"
    assert issue.target_date.isoformat() == "2026-09-30"
    assert activity.delay.call_args.kwargs["notification"] is True

    with patch("plane.app.views.issue.base.recent_visited_task"):
        native = api_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/")
    assert native.status_code == status.HTTP_200_OK
    assert str(native.data["state_id"]) == str(next_state.id)
    assert native.data["priority"] == "high"

    issue.name = "Changed elsewhere"
    issue.save(update_fields=["name", "updated_at"])
    stale = api_client.patch(
        update_url,
        {"source_version": updated.data["source_version"], "priority": "low"},
        format="json",
    )
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "WORK_ITEM_VERSION_CONFLICT"


def test_create_work_item_and_binding_is_atomic_and_idempotent(api_client, projection_project):
    user, workspace, project, _ = projection_project
    authenticate(api_client, user)
    operation_id = uuid.uuid4()
    create_url = f"{project_path(workspace, project)}/work-items/"
    payload = {
        "name": "Created from Canvas",
        "shape_id": "shape:created",
        "client_operation_id": str(operation_id),
        "priority": "urgent",
    }

    with (
        patch("plane.ppm_canvas.views.issue_activity") as activity,
        patch("plane.ppm_canvas.views.model_activity"),
        patch("plane.ppm_canvas.views.issue_description_version_task"),
    ):
        created = api_client.post(create_url, payload, format="json")
        replay = api_client.post(create_url, payload, format="json")

    assert created.status_code == status.HTTP_201_CREATED
    assert replay.status_code == status.HTTP_200_OK
    assert replay.data["binding_id"] == created.data["binding_id"]
    assert replay.data["idempotent_replay"] is True
    assert Issue.objects.filter(project=project, name="Created from Canvas", priority="urgent").count() == 1
    assert PpmCanvasBinding.objects.filter(project_id=project.id, shape_id="shape:created").count() == 1
    activity.delay.assert_called_once()

    reused = api_client.post(create_url, {**payload, "name": "Different"}, format="json")
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert Issue.objects.filter(project=project).count() == 1


def test_invalid_work_item_create_rolls_back_source_and_binding(api_client, projection_project):
    user, workspace, project, _ = projection_project
    authenticate(api_client, user)

    response = api_client.post(
        f"{project_path(workspace, project)}/work-items/",
        {
            "name": "Must roll back",
            "shape_id": "shape:rollback",
            "client_operation_id": str(uuid.uuid4()),
            "state_id": str(uuid.uuid4()),
        },
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "WORK_ITEM_INVALID"
    assert not Issue.all_objects.filter(project=project, name="Must roll back").exists()
    assert not PpmCanvasBinding.objects.filter(project_id=project.id, shape_id="shape:rollback").exists()


def test_guest_cannot_bind_create_or_quick_edit(api_client, projection_project):
    owner, workspace, project, state = projection_project
    issue = create_issue(project, state, owner)
    guest = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    authenticate(api_client, guest)

    bind = api_client.post(bindings_url(workspace, project), bind_payload(issue), format="json")
    create = api_client.post(
        f"{project_path(workspace, project)}/work-items/",
        {"name": "No", "shape_id": "shape:no", "client_operation_id": str(uuid.uuid4())},
        format="json",
    )
    update = api_client.patch(
        f"{project_path(workspace, project)}/work-items/{issue.id}/",
        {"source_version": issue.updated_at.isoformat(), "priority": "high"},
        format="json",
    )

    assert bind.status_code == status.HTTP_403_FORBIDDEN
    assert create.status_code == status.HTTP_403_FORBIDDEN
    assert update.status_code == status.HTTP_403_FORBIDDEN
    assert PpmCanvasBinding.objects.count() == 0
