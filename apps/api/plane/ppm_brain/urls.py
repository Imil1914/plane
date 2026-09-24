from django.urls import path

from .views import (
    PpmBrainAgentActionReviewView,
    PpmBrainAgentRegistryView,
    PpmBrainAgentRunCancelView,
    PpmBrainAgentRunBatchApplyView,
    PpmBrainAgentRunBatchReviewView,
    PpmBrainAgentRunDetailView,
    PpmBrainAgentRunListCreateView,
    PpmBrainAgentRunRetryView,
    PpmBrainAgentRunStreamCreateView,
    PpmBrainAgentRunStreamRetryView,
    PpmBrainAnswerRunCancelView,
    PpmBrainAnswerRunDetailView,
    PpmBrainAnswerRunEventsView,
    PpmBrainAnswerRunListCreateView,
    PpmBrainAnswerRunStreamCreateView,
    PpmBrainHealthView,
    PpmBrainJobView,
    PpmBrainMemoryDetailView,
    PpmBrainMemoryListCreateView,
    PpmBrainQueryView,
    PpmBrainQueryStreamView,
    PpmBrainReindexView,
    PpmBrainSourceIndexView,
    PpmBrainSourceListView,
)


PROJECT = "workspaces/<uuid:workspace_id>/projects/<uuid:project_id>/knowledge/"

urlpatterns = [
    path(f"{PROJECT}agents/registry/", PpmBrainAgentRegistryView.as_view(), name="ppm-brain-agent-registry"),
    path(f"{PROJECT}agents/runs/", PpmBrainAgentRunListCreateView.as_view(), name="ppm-brain-agent-runs"),
    path(
        f"{PROJECT}agents/runs/stream/",
        PpmBrainAgentRunStreamCreateView.as_view(),
        name="ppm-brain-agent-run-stream",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/",
        PpmBrainAgentRunDetailView.as_view(),
        name="ppm-brain-agent-run",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/cancel/",
        PpmBrainAgentRunCancelView.as_view(),
        name="ppm-brain-agent-run-cancel",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/review/",
        PpmBrainAgentRunBatchReviewView.as_view(),
        name="ppm-brain-agent-run-batch-review",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/apply/",
        PpmBrainAgentRunBatchApplyView.as_view(),
        name="ppm-brain-agent-run-batch-apply",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/retry/",
        PpmBrainAgentRunRetryView.as_view(),
        name="ppm-brain-agent-run-retry",
    ),
    path(
        f"{PROJECT}agents/runs/<uuid:run_id>/retry/stream/",
        PpmBrainAgentRunStreamRetryView.as_view(),
        name="ppm-brain-agent-run-retry-stream",
    ),
    path(
        f"{PROJECT}agents/actions/<uuid:action_id>/review/",
        PpmBrainAgentActionReviewView.as_view(),
        name="ppm-brain-agent-action-review",
    ),
    path(f"{PROJECT}sources/", PpmBrainSourceListView.as_view(), name="ppm-brain-source-list"),
    path(
        f"{PROJECT}sources/<str:source_type>/<str:source_id>/index/",
        PpmBrainSourceIndexView.as_view(),
        name="ppm-brain-source-index",
    ),
    path(f"{PROJECT}reindex/", PpmBrainReindexView.as_view(), name="ppm-brain-reindex"),
    path(f"{PROJECT}jobs/<uuid:job_id>/", PpmBrainJobView.as_view(), name="ppm-brain-job"),
    path(f"{PROJECT}query/", PpmBrainQueryView.as_view(), name="ppm-brain-query"),
    path(
        f"{PROJECT}query/stream/",
        PpmBrainQueryStreamView.as_view(),
        name="ppm-brain-query-stream",
    ),
    path(f"{PROJECT}memory/", PpmBrainMemoryListCreateView.as_view(), name="ppm-brain-memory"),
    path(
        f"{PROJECT}memory/<uuid:memory_id>/",
        PpmBrainMemoryDetailView.as_view(),
        name="ppm-brain-memory-detail",
    ),
    path(f"{PROJECT}answers/", PpmBrainAnswerRunListCreateView.as_view(), name="ppm-brain-answer-runs"),
    path(
        f"{PROJECT}answers/stream/",
        PpmBrainAnswerRunStreamCreateView.as_view(),
        name="ppm-brain-answer-run-stream",
    ),
    path(
        f"{PROJECT}answers/<uuid:run_id>/",
        PpmBrainAnswerRunDetailView.as_view(),
        name="ppm-brain-answer-run",
    ),
    path(
        f"{PROJECT}answers/<uuid:run_id>/cancel/",
        PpmBrainAnswerRunCancelView.as_view(),
        name="ppm-brain-answer-run-cancel",
    ),
    path(
        f"{PROJECT}answers/<uuid:run_id>/events/",
        PpmBrainAnswerRunEventsView.as_view(),
        name="ppm-brain-answer-run-events",
    ),
    path(f"{PROJECT}health/", PpmBrainHealthView.as_view(), name="ppm-brain-health"),
]
