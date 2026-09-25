import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import Page, ProjectPage
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasEntityType
from plane.ppm_canvas.services import get_or_create_active_canvas
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(display_name=""):
    marker = uuid.uuid4().hex
    user = UserFactory(username=f"pages-{marker}", email=f"pages-{marker}@plane.test")
    if display_name:
        user.display_name = display_name
        user.save(update_fields=["display_name"])
    return user


@pytest.fixture
def pages_project():
    owner = make_user("Анна")
    colleague = make_user("Борис")
    workspace = WorkspaceFactory(owner=owner)
    project = ProjectFactory(workspace=workspace, identifier="PGS")
    for member in (owner, colleague):
        WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
        ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    return owner, colleague, workspace, project


def make_page(workspace, project, owner, name, *, access=Page.PUBLIC_ACCESS, html="<p>Текст</p>"):
    page = Page.objects.create(
        workspace=workspace,
        name=name,
        description_html=html,
        owned_by=owner,
        access=access,
    )
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    return page


def search_pages(api_client, workspace, project, **params):
    return api_client.get(
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/projections/search/",
        {"types": "page", **params},
    )


def result_ids(response):
    return [item["identity"]["entity_id"] for item in response.data["results"]]


def test_page_search_returns_only_pages_visible_to_the_user(api_client, pages_project):
    owner, colleague, workspace, project = pages_project
    public = make_page(workspace, project, colleague, "Регламент планёрки", html="<p>Каждый вторник</p>")
    own_private = make_page(workspace, project, owner, "Мои заметки", access=Page.PRIVATE_ACCESS)
    foreign_private = make_page(workspace, project, colleague, "Личное Бориса", access=Page.PRIVATE_ACCESS)
    archived = make_page(workspace, project, owner, "Старый план")
    archived.archived_at = timezone.now().date()
    archived.save(update_fields=["archived_at"])
    deleted = make_page(workspace, project, owner, "Удалённый")
    deleted.deleted_at = timezone.now()
    deleted.save(update_fields=["deleted_at"])
    unlinked = make_page(workspace, project, owner, "Отвязанный")
    ProjectPage.objects.filter(page=unlinked).delete()
    other_project = ProjectFactory(workspace=workspace, identifier="PGS2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=15)
    elsewhere = make_page(workspace, other_project, owner, "Чужой проект")
    sub_page = Page.objects.create(
        workspace=workspace,
        name="Подстраница регламента",
        description_html="<p>Детали</p>",
        owned_by=colleague,
        access=Page.PUBLIC_ACCESS,
        parent=public,
    )
    ProjectPage.objects.create(workspace=workspace, project=project, page=sub_page)
    api_client.force_authenticate(user=owner)

    response = search_pages(api_client, workspace, project)

    assert response.status_code == status.HTTP_200_OK
    # A private page is never offered by search, even the requester's own one: a bound card's
    # title lands in the board's shared snapshot, so `own_private` must not leak that way.
    assert set(result_ids(response)) == {str(public.id)}
    for hidden in (own_private, foreign_private, archived, deleted, unlinked, elsewhere, sub_page):
        assert str(hidden.id) not in result_ids(response)
    item = next(result for result in response.data["results"] if result["identity"]["entity_id"] == str(public.id))
    assert item["identity"] == {
        "entity_type": "page",
        "entity_id": str(public.id),
        "workspace_id": str(workspace.id),
        "project_id": str(project.id),
        "source_url": f"/{workspace.slug}/projects/{project.id}/pages/{public.id}",
    }
    assert item["display"]["title"] == "Регламент планёрки"
    assert item["display"]["excerpt"] == "Каждый вторник"
    assert item["display"]["source_status"] == "active"
    assert item["source_version"] == public.updated_at.isoformat()
    assert item["page"] == {
        "updated_at": public.updated_at.isoformat(),
        "owned_by": {"id": str(colleague.id), "display_name": "Борис"},
        "access": "public",
    }
    assert "Личное Бориса" not in str(response.data)


def test_page_search_filters_ranks_by_title_and_paginates(api_client, pages_project):
    owner, _, workspace, project = pages_project
    body_match = make_page(workspace, project, owner, "Протокол", html="<p>Итог: карта проекта готова</p>")
    title_match = make_page(workspace, project, owner, "Карта проекта")
    make_page(workspace, project, owner, "Бюджет")
    api_client.force_authenticate(user=owner)

    first = search_pages(api_client, workspace, project, q="карта", limit=1)
    second = search_pages(api_client, workspace, project, q="карта", limit=1, cursor=first.data["next_cursor"])
    mixed = api_client.get(
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/projections/search/",
        {"types": "page,work_item"},
    )
    too_many = search_pages(api_client, workspace, project, limit=500)

    assert result_ids(first) == [str(title_match.id)]
    assert first.data["next_cursor"] == "1"
    assert result_ids(second) == [str(body_match.id)]
    assert second.data["next_cursor"] is None
    assert mixed.status_code == status.HTTP_400_BAD_REQUEST
    assert mixed.data["error"]["code"] == "PROJECTION_SEARCH_INVALID"
    assert too_many.status_code == status.HTTP_400_BAD_REQUEST


def test_page_search_requires_project_membership(api_client, pages_project):
    owner, _, workspace, project = pages_project
    make_page(workspace, project, owner, "Секретная стратегия")
    outsider = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    guest = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    # project.guest_view_all_features defaults to False, so this guest is restricted (see
    # test_page_search_restricts_guest_to_own_public_pages): give them their own public page so
    # the membership check below still has something to find.
    guest_page = make_page(workspace, project, guest, "Гостевая заметка")

    api_client.force_authenticate(user=outsider)
    denied = search_pages(api_client, workspace, project)
    api_client.force_authenticate(user=guest)
    guest_view = search_pages(api_client, workspace, project)

    assert denied.status_code == status.HTTP_403_FORBIDDEN
    assert denied.data["error"]["code"] == "CANVAS_PERMISSION_DENIED"
    assert "Секретная стратегия" not in str(denied.data)
    assert guest_view.status_code == status.HTTP_200_OK
    assert result_ids(guest_view) == [str(guest_page.id)]
    assert [item["display"]["title"] for item in guest_view.data["results"]] == ["Гостевая заметка"]
    assert guest_view.data["results"][0]["capabilities"]["update"] is False
    # The restricted guest must not see the owner's public page either (the privacy gap this
    # fix closes).
    assert "Секретная стратегия" not in str(guest_view.data)


def add_guest(workspace, project, *, display_name="Гость"):
    guest = make_user(display_name)
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    return guest


def bind_page(*, workspace, project, canvas, board, page, user, shape_id="shape:page-1"):
    return PpmCanvasBinding.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        canvas=canvas,
        board=board,
        shape_id=shape_id,
        entity_type=PpmCanvasEntityType.PAGE,
        entity_id=page.id,
        status=PpmCanvasBindingStatus.ACTIVE,
        client_operation_id=uuid.uuid4(),
        operation_fingerprint=f"binding-{shape_id}",
        created_by=user.id,
    )


def test_page_search_restricts_guest_to_own_public_pages(api_client, pages_project):
    """A restricted guest (Plane's guest_view_all_features rule, default False) must only find
    public pages they own themselves — not another member's public page, and never any private
    page, even their own (private pages are never offered by canvas search)."""
    owner, colleague, workspace, project = pages_project
    guest = add_guest(workspace, project)
    own_public = make_page(workspace, project, guest, "Заметка гостя")
    own_private = make_page(workspace, project, guest, "Приватная заметка гостя", access=Page.PRIVATE_ACCESS)
    others_public = make_page(workspace, project, owner, "Общий регламент")
    others_private = make_page(workspace, project, colleague, "Приватное Бориса", access=Page.PRIVATE_ACCESS)
    api_client.force_authenticate(user=guest)

    response = search_pages(api_client, workspace, project)

    assert response.status_code == status.HTTP_200_OK
    assert result_ids(response) == [str(own_public.id)]
    for hidden in (own_private, others_public, others_private):
        assert str(hidden.id) not in result_ids(response)
    assert "Общий регламент" not in str(response.data)


def test_page_search_guest_view_all_features_true_grants_normal_visibility(api_client, pages_project):
    """With guest_view_all_features on, a guest is no longer restricted: they see every public
    page in the project (not just their own), same as a regular member — but still never a
    private page, since canvas search excludes those for everyone."""
    owner, _, workspace, project = pages_project
    project.guest_view_all_features = True
    project.save(update_fields=["guest_view_all_features"])
    guest = add_guest(workspace, project)
    others_public = make_page(workspace, project, owner, "Общий регламент")
    own_private = make_page(workspace, project, guest, "Приватная заметка гостя", access=Page.PRIVATE_ACCESS)
    api_client.force_authenticate(user=guest)

    response = search_pages(api_client, workspace, project)

    assert response.status_code == status.HTTP_200_OK
    assert result_ids(response) == [str(others_public.id)]
    assert str(own_private.id) not in result_ids(response)


def test_guest_page_binding_becomes_unavailable_when_restricted(api_client, pages_project):
    """A card already bound to someone else's public page must render as unavailable for a
    restricted guest — the privacy gap this fix closes for page cards/bindings, not just search.
    Once the project opts into guest_view_all_features, the same guest's binding resolves again."""
    owner, _, workspace, project = pages_project
    guest = add_guest(workspace, project)
    others_public = make_page(workspace, project, owner, "Общий регламент", html="<p>Детали регламента</p>")
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
    board = canvas.default_board
    binding = bind_page(
        workspace=workspace, project=project, canvas=canvas, board=board, page=others_public, user=owner
    )
    canvas_endpoint = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/"
    api_client.force_authenticate(user=guest)

    restricted = api_client.get(canvas_endpoint)
    restricted_binding = next(b for b in restricted.data["bindings"] if b["binding_id"] == str(binding.id))

    assert restricted.status_code == status.HTTP_200_OK
    assert restricted_binding["source"]["display"]["title"] == "Удалённый или недоступный материал"
    assert restricted_binding["source"]["display"]["source_status"] == "deleted"
    assert restricted_binding["source"]["capabilities"]["read"] is False
    assert "Общий регламент" not in str(restricted.data)
    assert "Детали регламента" not in str(restricted.data)

    project.guest_view_all_features = True
    project.save(update_fields=["guest_view_all_features"])

    unrestricted = api_client.get(canvas_endpoint)
    unrestricted_binding = next(b for b in unrestricted.data["bindings"] if b["binding_id"] == str(binding.id))

    assert unrestricted_binding["source"]["display"]["title"] == "Общий регламент"
    assert unrestricted_binding["source"]["capabilities"]["read"] is True


def test_owner_private_page_binding_still_resolves_for_owner(api_client, pages_project):
    """get_content_source keeps its existing «public OR own private» rule: an already-bound
    private page still renders for its own owner (only the guest rule is new, and it does not
    apply to a regular member)."""
    owner, _, workspace, project = pages_project
    own_private = make_page(
        workspace, project, owner, "Личный план", access=Page.PRIVATE_ACCESS, html="<p>Черновик</p>"
    )
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
    board = canvas.default_board
    binding = bind_page(
        workspace=workspace,
        project=project,
        canvas=canvas,
        board=board,
        page=own_private,
        user=owner,
        shape_id="shape:page-private",
    )
    api_client.force_authenticate(user=owner)

    response = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/")
    resolved_binding = next(b for b in response.data["bindings"] if b["binding_id"] == str(binding.id))

    assert response.status_code == status.HTTP_200_OK
    assert resolved_binding["source"]["display"]["title"] == "Личный план"
    assert resolved_binding["source"]["capabilities"]["read"] is True


def project_members_query_count(captured):
    return sum(1 for query in captured.captured_queries if "project_members" in query["sql"])


def test_canvas_board_fetch_does_not_add_a_project_members_query_per_page_binding(api_client, pages_project):
    """The restricted-guest check must be computed once per request (see `get_canvas_bindings_payload`),
    not once per PAGE binding inside `get_content_source`: opening a board with many page cards must
    not add one `project_members` query per card. Compares the query count for a board with a single
    page binding against the same board after five more are added — it must not grow."""
    owner, _, workspace, project = pages_project
    guest = add_guest(workspace, project)
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
    board = canvas.default_board
    first_page = make_page(workspace, project, owner, "Регламент 1")
    bind_page(workspace=workspace, project=project, canvas=canvas, board=board, page=first_page, user=owner)
    canvas_endpoint = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/"
    api_client.force_authenticate(user=guest)

    with CaptureQueriesContext(connection) as single_binding:
        one_card_response = api_client.get(canvas_endpoint)
    assert one_card_response.status_code == status.HTTP_200_OK
    assert len(one_card_response.data["bindings"]) == 1

    for index in range(2, 7):
        extra_page = make_page(workspace, project, owner, f"Регламент {index}")
        bind_page(
            workspace=workspace,
            project=project,
            canvas=canvas,
            board=board,
            page=extra_page,
            user=owner,
            shape_id=f"shape:page-{index}",
        )

    with CaptureQueriesContext(connection) as six_bindings:
        six_cards_response = api_client.get(canvas_endpoint)
    assert six_cards_response.status_code == status.HTTP_200_OK
    assert len(six_cards_response.data["bindings"]) == 6

    assert project_members_query_count(six_bindings) == project_members_query_count(single_binding)
