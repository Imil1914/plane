"""Contract: the Vault on S3-style object storage — the production path.

Every other Vault test runs with ``PPM_LOCAL_ASSET_UPLOADS=True`` (local disk). Here the real ``S3Storage`` code
talks to an in-memory S3 double through its ``s3_client``. The double keeps the quirk of the real class that
caused the RC P1: ``S3Storage`` never initialises ``S3Boto3Storage``, so its django-storages API (``open()``)
is unusable and server-side reads must go through ``s3_client.get_object``. Covered readers: preview, ZIP
export and the Brain PDF indexing read; storage failures must surface as storage errors, never as crashes.
"""

import io
import uuid
import zipfile
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.response import StreamingBody
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status

from plane.ppm_brain.adapters import PpmBrainSourceError, load_vault_file
from plane.ppm_vault.storage import open_private_object
from plane.settings.storage import S3Storage
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

PUBLIC_ORIGIN = "https://ppm.example.test"


def make_pdf(text):
    """Smallest valid one-page PDF with extractable text (correct xref offsets)."""
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(bodies, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(bodies) + 1, xref)
    return bytes(out)


class FakeS3Client:
    """In-memory bucket behind the boto3 client API used by S3Storage."""

    def __init__(self, bucket):
        self.bucket = bucket
        self.objects = bucket.objects

    def _check(self):
        if self.bucket.outage is not None:
            raise self.bucket.outage

    def upload_fileobj(self, Fileobj, Bucket, Key, ExtraArgs=None):
        self._check()
        self.objects[Key] = Fileobj.read()

    def get_object(self, Bucket, Key):
        self._check()
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "No such key."}}, "GetObject")
        data = self.objects[Key]
        return {"Body": StreamingBody(CountingStream(data, self.bucket), len(data)), "ContentLength": len(data)}

    def copy_object(self, Bucket, CopySource, Key):
        self._check()
        if CopySource["Key"] not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "CopyObject")
        self.objects[Key] = self.objects[CopySource["Key"]]
        return {"CopyObjectResult": {}}

    def delete_objects(self, Bucket, Delete):
        self._check()
        for item in Delete["Objects"]:
            self.objects.pop(item["Key"], None)
        return {}

    def generate_presigned_url(self, ClientMethod, Params, ExpiresIn, HttpMethod):
        return f"{PUBLIC_ORIGIN}/uploads/{Params['Key']}?X-Amz-Expires={ExpiresIn}&X-Amz-Signature=test"


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.outage = None
        self.bytes_served = 0


class CountingStream(io.BytesIO):
    """Object body that records how many bytes a reader actually pulled from storage."""

    def __init__(self, data, bucket):
        super().__init__(data)
        self.bucket = bucket

    def read(self, size=-1):
        chunk = super().read(size)
        self.bucket.bytes_served += len(chunk)
        return chunk


class FakeS3Storage(S3Storage):
    """Real S3Storage methods over the fake transport. Like the real class, S3Boto3Storage is not initialised."""

    bucket = FakeBucket()

    def __init__(self, request=None, is_server=False):
        self.aws_storage_bucket_name = "uploads"
        self.signed_url_expiration = 3600
        self.s3_client = FakeS3Client(FakeS3Storage.bucket)


@pytest.fixture
def s3_vault(settings):
    settings.PPM_LOCAL_ASSET_UPLOADS = False
    settings.CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": f"ppm-vault-s3-{uuid.uuid4().hex}",
        }
    }
    FakeS3Storage.bucket = FakeBucket()
    marker = uuid.uuid4().hex
    user = UserFactory(username=f"vault-s3-{marker}", email=f"vault-s3-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="VS3")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    with patch("plane.ppm_vault.storage.S3Storage", FakeS3Storage):
        yield user, workspace, project, FakeS3Storage.bucket


def vault_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/{suffix}"


def upload(api_client, workspace, project, name, payload, content_type="application/octet-stream"):
    response = api_client.post(
        vault_url(workspace, project, "files/"),
        {"file": SimpleUploadedFile(name, payload, content_type=content_type)},
        format="multipart",
    )
    assert response.status_code == status.HTTP_201_CREATED, response.data
    return response.data


def object_key_of(bucket, payload):
    keys = [key for key, data in bucket.objects.items() if data == payload]
    assert len(keys) == 1, keys
    return keys[0]


def test_s3_upload_stores_private_object_and_preview_reads_it_back(api_client, s3_vault):
    user, workspace, project, bucket = s3_vault
    api_client.force_authenticate(user=user)
    payload = "Протокол планёрки RC\nstatus: ok\n".encode()

    entry = upload(api_client, workspace, project, "notes.txt", payload)
    key = object_key_of(bucket, payload)
    assert key.startswith("ppm-vault/") and "notes" not in key

    preview = api_client.get(vault_url(workspace, project, f"entries/{entry['id']}/preview/"))
    assert preview.status_code == status.HTTP_200_OK, preview.content
    assert preview.data["kind"] == "text"
    assert "Протокол планёрки RC" in preview.data["text"]


def test_s3_new_version_download_redirects_to_public_presigned_url(api_client, s3_vault):
    user, workspace, project, bucket = s3_vault
    api_client.force_authenticate(user=user)
    entry = upload(api_client, workspace, project, "plan.txt", b"version one\n")
    replaced = api_client.put(
        vault_url(workspace, project, f"entries/{entry['id']}/file/"),
        {"file": SimpleUploadedFile("plan.txt", b"version two\n"), "base_version": entry["version"]},
        format="multipart",
    )
    assert replaced.status_code == status.HTTP_200_OK, replaced.data

    current = api_client.get(vault_url(workspace, project, f"entries/{entry['id']}/file/"))
    old = api_client.get(vault_url(workspace, project, f"entries/{entry['id']}/versions/1/"))
    for response, expected in ((current, b"version two\n"), (old, b"version one\n")):
        assert response.status_code == status.HTTP_302_FOUND
        assert response["Location"].startswith(f"{PUBLIC_ORIGIN}/uploads/ppm-vault/")
        key = response["Location"].split("/uploads/", 1)[1].split("?", 1)[0]
        assert bucket.objects[key] == expected


def test_s3_export_zip_contains_the_stored_bytes(api_client, s3_vault):
    user, workspace, project, _ = s3_vault
    api_client.force_authenticate(user=user)
    text = b"exported through S3\n"
    pdf = make_pdf("RC export marker")
    upload(api_client, workspace, project, "export.txt", text)
    upload(api_client, workspace, project, "export.pdf", pdf)

    response = api_client.get(vault_url(workspace, project, "export/"))
    assert response.status_code == status.HTTP_200_OK
    archive = zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content)))
    assert archive.read("export.txt") == text
    assert archive.read("export.pdf") == pdf


def test_s3_brain_pdf_indexing_reads_the_object_text(api_client, s3_vault):
    user, workspace, project, _ = s3_vault
    api_client.force_authenticate(user=user)
    entry = upload(api_client, workspace, project, "spec.pdf", make_pdf("rcpdfmarker indexed from S3"))
    assert entry["kind"] == "pdf"

    document = load_vault_file(workspace_id=workspace.id, project_id=project.id, source_id=entry["id"])

    assert "rcpdfmarker indexed from S3" in " ".join(part.text for part in document.parts)


def test_s3_missing_object_is_a_storage_error_for_every_reader(api_client, s3_vault):
    user, workspace, project, bucket = s3_vault
    api_client.force_authenticate(user=user)
    text_entry = upload(api_client, workspace, project, "lost.txt", b"soon gone\n")
    pdf_entry = upload(api_client, workspace, project, "lost.pdf", make_pdf("lost"))
    bucket.objects.clear()

    assert open_private_object("ppm-vault/missing/object.txt") is None
    preview = api_client.get(vault_url(workspace, project, f"entries/{text_entry['id']}/preview/"))
    assert preview.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert preview.data["error"]["code"] == "VAULT_STORAGE_FAILED"
    export = api_client.get(vault_url(workspace, project, "export/"))
    assert export.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert export.data["error"]["code"] == "VAULT_STORAGE_FAILED"
    with pytest.raises(PpmBrainSourceError) as failure:
        load_vault_file(workspace_id=workspace.id, project_id=project.id, source_id=pdf_entry["id"])
    assert failure.value.code == "VAULT_STORAGE_UNAVAILABLE" and failure.value.retryable is True


def test_s3_outage_fails_upload_and_reads_cleanly(api_client, s3_vault):
    user, workspace, project, bucket = s3_vault
    api_client.force_authenticate(user=user)
    entry = upload(api_client, workspace, project, "before.txt", b"stored before the outage\n")
    stored_key = object_key_of(bucket, b"stored before the outage\n")
    bucket.outage = EndpointConnectionError(endpoint_url=f"{PUBLIC_ORIGIN}/uploads")

    failed = api_client.post(
        vault_url(workspace, project, "files/"),
        {"file": SimpleUploadedFile("during.txt", b"not stored\n")},
        format="multipart",
    )
    assert failed.status_code == status.HTTP_503_SERVICE_UNAVAILABLE, failed.content
    assert failed.data["error"]["code"] == "VAULT_STORAGE_FAILED"
    tree = api_client.get(vault_url(workspace, project, "tree/"))
    assert "during.txt" not in str(tree.data)
    preview = api_client.get(vault_url(workspace, project, f"entries/{entry['id']}/preview/"))
    assert preview.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert open_private_object(stored_key) is None


def test_s3_preview_never_loads_more_than_its_source_limit(api_client, s3_vault, settings):
    user, workspace, project, bucket = s3_vault
    api_client.force_authenticate(user=user)
    entry = upload(api_client, workspace, project, "small.txt", b"short text\n")
    key = object_key_of(bucket, b"short text\n")
    settings.PPM_VAULT_PREVIEW_SOURCE_MAX_BYTES = 64
    bucket.objects[key] = b"x" * 100_000  # the stored object no longer matches the recorded size
    bucket.bytes_served = 0

    preview = api_client.get(vault_url(workspace, project, f"entries/{entry['id']}/preview/"))

    assert preview.status_code == status.HTTP_200_OK, preview.content
    assert preview.data["kind"] == "unsupported" and preview.data["reason"] == "too_large"
    assert bucket.bytes_served <= 65


def test_s3_whole_object_read_is_refused_above_the_read_ceiling(s3_vault, settings):
    _, _, _, bucket = s3_vault
    settings.PPM_VAULT_READ_MAX_BYTES = 100
    bucket.objects["ppm-vault/big.bin"] = b"y" * 1000
    bucket.objects["ppm-vault/fits.bin"] = b"z" * 100

    assert open_private_object("ppm-vault/big.bin") is None
    assert bucket.bytes_served == 0  # refused by ContentLength before the body is read
    handle = open_private_object("ppm-vault/fits.bin")
    assert handle.read() == b"z" * 100


def test_s3_failures_log_the_s3_error_code_not_just_the_class(s3_vault):
    with patch("plane.ppm_vault.storage.logger") as log:
        assert open_private_object("ppm-vault/missing/object.bin") is None

    (message,) = log.warning.call_args.args
    assert message == "PPM vault object read failed"
    assert log.warning.call_args.kwargs["extra"] == {"error": "ClientError", "code": "NoSuchKey"}
