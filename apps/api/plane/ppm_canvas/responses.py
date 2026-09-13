import uuid

from rest_framework.response import Response


def get_request_id(request):
    cached = getattr(request, "_ppm_request_id", None)
    if cached is not None:
        return cached

    raw_request_id = request.headers.get("X-Request-ID", "")
    try:
        request_id = uuid.UUID(raw_request_id)
    except (TypeError, ValueError, AttributeError):
        request_id = uuid.uuid4()
    request._ppm_request_id = request_id
    return request_id


def ppm_error_response(request, *, code, message, status_code, details=None):
    return Response(
        {
            "error": {
                "code": code,
                "message": message,
                "request_id": str(get_request_id(request)),
                "details": details or {},
            }
        },
        status=status_code,
    )
