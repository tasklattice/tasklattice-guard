"""TaskLattice canonical safety taxonomy and model-provider adapters."""

from .mappings import MappingQuality, ProviderCategoryMapping, provider_mapping
from .providers import (
    ConfiguredSafetyModelProvider,
    ModelClient,
    ModelCompletionRequest,
    ModelCompletionResponse,
    NativeSafetyAssessment,
    OpenAIChatModelClient,
    SafetyModelProvider,
    SafetyModelProtocolAdapter,
    build_safety_model_provider,
)
from .taxonomy import (
    TALI_TAXONOMY_ID,
    TALI_TAXONOMY_VERSION,
    TaxonomyCategory,
    TaxonomyRegistry,
    taxonomy,
)

__all__ = (
    "MappingQuality",
    "ConfiguredSafetyModelProvider",
    "ModelClient",
    "ModelCompletionRequest",
    "ModelCompletionResponse",
    "NativeSafetyAssessment",
    "OpenAIChatModelClient",
    "ProviderCategoryMapping",
    "SafetyModelProvider",
    "SafetyModelProtocolAdapter",
    "TALI_TAXONOMY_ID",
    "TALI_TAXONOMY_VERSION",
    "TaxonomyCategory",
    "TaxonomyRegistry",
    "build_safety_model_provider",
    "provider_mapping",
    "taxonomy",
)
