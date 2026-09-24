from abc import ABC, abstractmethod

from django.conf import settings


class PpmEmbeddingProviderError(Exception):
    def __init__(self, *, code, message):
        self.code = code
        self.message = message
        super().__init__(message)


class PpmEmbeddingProvider(ABC):
    name = "disabled"
    model = ""
    enabled = False

    @abstractmethod
    def embed_documents(self, texts):
        raise NotImplementedError

    @abstractmethod
    def embed_query(self, text):
        raise NotImplementedError


class DisabledEmbeddingProvider(PpmEmbeddingProvider):
    def embed_documents(self, texts):
        return [None for _ in texts]

    def embed_query(self, text):
        return None


class OpenAIEmbeddingProvider(PpmEmbeddingProvider):
    name = "openai"
    enabled = True

    def __init__(self):
        if not getattr(settings, "PPM_BRAIN_ALLOW_EXTERNAL_EMBEDDINGS", False):
            raise PpmEmbeddingProviderError(
                code="EMBEDDING_EGRESS_NOT_APPROVED",
                message="Внешняя обработка текста не разрешена политикой PPM.",
            )
        try:
            from openai import OpenAI

            self.client = OpenAI()
        except Exception as exc:
            raise PpmEmbeddingProviderError(
                code="EMBEDDING_PROVIDER_UNAVAILABLE",
                message="Провайдер смыслового поиска не настроен.",
            ) from exc
        self.model = getattr(settings, "PPM_BRAIN_EMBEDDING_MODEL", "text-embedding-3-small")
        self.dimensions = getattr(settings, "PPM_BRAIN_EMBEDDING_DIMENSIONS", None)

    def _embed(self, texts):
        kwargs = {"input": texts, "model": self.model}
        if self.dimensions:
            kwargs["dimensions"] = self.dimensions
        try:
            response = self.client.embeddings.create(**kwargs)
        except Exception as exc:
            raise PpmEmbeddingProviderError(
                code="EMBEDDING_PROVIDER_FAILED",
                message="Смысловой поиск временно недоступен.",
            ) from exc
        return [item.embedding for item in response.data]

    def embed_documents(self, texts):
        return self._embed(texts)

    def embed_query(self, text):
        return self._embed([text])[0]


def get_embedding_provider():
    provider = str(getattr(settings, "PPM_BRAIN_EMBEDDING_PROVIDER", "disabled") or "disabled").casefold()
    if provider in {"", "disabled", "none"}:
        return DisabledEmbeddingProvider()
    if provider == "openai":
        return OpenAIEmbeddingProvider()
    raise PpmEmbeddingProviderError(
        code="EMBEDDING_PROVIDER_UNSUPPORTED",
        message="Указан неподдерживаемый провайдер смыслового поиска.",
    )
