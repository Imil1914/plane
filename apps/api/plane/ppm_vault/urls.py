from django.urls import path

from .views import (
    PpmVaultBacklinksView,
    PpmVaultEntryView,
    PpmVaultEntryTransfersView,
    PpmVaultExportView,
    PpmVaultFileContentView,
    PpmVaultFileUploadView,
    PpmVaultFolderCreateView,
    PpmVaultGraphView,
    PpmVaultMarkdownContentView,
    PpmVaultMarkdownCreateView,
    PpmVaultPageExportView,
    PpmVaultPageImportView,
    PpmVaultPdfContentView,
    PpmVaultPdfUploadView,
    PpmVaultTransferPagesView,
    PpmVaultTrashRestoreView,
    PpmVaultTrashView,
    PpmVaultVersionContentView,
    PpmVaultVersionRestoreView,
    PpmVaultVersionsView,
    PpmVaultView,
)


PROJECT = "workspaces/<uuid:workspace_id>/projects/<uuid:project_id>/vault/"

urlpatterns = [
    path(PROJECT, PpmVaultView.as_view(), name="ppm-project-vault"),
    path(f"{PROJECT}tree/", PpmVaultView.as_view(), name="ppm-project-vault-tree"),
    path(f"{PROJECT}graph/", PpmVaultGraphView.as_view(), name="ppm-vault-graph"),
    path(f"{PROJECT}trash/", PpmVaultTrashView.as_view(), name="ppm-vault-trash"),
    path(f"{PROJECT}export/", PpmVaultExportView.as_view(), name="ppm-vault-export"),
    path(f"{PROJECT}transfers/pages/", PpmVaultTransferPagesView.as_view(), name="ppm-vault-transfer-pages"),
    path(
        f"{PROJECT}transfers/pages/<uuid:page_id>/import/",
        PpmVaultPageImportView.as_view(),
        name="ppm-vault-page-import",
    ),
    path(f"{PROJECT}folders/", PpmVaultFolderCreateView.as_view(), name="ppm-vault-folder-create"),
    path(f"{PROJECT}markdown/", PpmVaultMarkdownCreateView.as_view(), name="ppm-vault-markdown-create"),
    path(f"{PROJECT}pdf/", PpmVaultPdfUploadView.as_view(), name="ppm-vault-pdf-upload"),
    path(f"{PROJECT}files/", PpmVaultFileUploadView.as_view(), name="ppm-vault-file-upload"),
    path(f"{PROJECT}entries/<uuid:entry_id>/", PpmVaultEntryView.as_view(), name="ppm-vault-entry"),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/backlinks/",
        PpmVaultBacklinksView.as_view(),
        name="ppm-vault-backlinks",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/versions/",
        PpmVaultVersionsView.as_view(),
        name="ppm-vault-versions",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/versions/<int:version_number>/",
        PpmVaultVersionContentView.as_view(),
        name="ppm-vault-version-content",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/versions/<int:version_number>/restore/",
        PpmVaultVersionRestoreView.as_view(),
        name="ppm-vault-version-restore",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/restore/",
        PpmVaultTrashRestoreView.as_view(),
        name="ppm-vault-trash-restore",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/transfers/",
        PpmVaultEntryTransfersView.as_view(),
        name="ppm-vault-entry-transfers",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/export-page/",
        PpmVaultPageExportView.as_view(),
        name="ppm-vault-page-export",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/content/",
        PpmVaultMarkdownContentView.as_view(),
        name="ppm-vault-markdown-content",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/pdf/",
        PpmVaultPdfContentView.as_view(),
        name="ppm-vault-pdf-content",
    ),
    path(
        f"{PROJECT}entries/<uuid:entry_id>/file/",
        PpmVaultFileContentView.as_view(),
        name="ppm-vault-file-content",
    ),
]
