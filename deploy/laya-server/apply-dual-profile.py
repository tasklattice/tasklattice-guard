"""Add a deployment-only dual profile to the pinned laya-server v0.1.2 source.

No request/response schema or inference parameters are changed. Fail the build
if the pinned source no longer matches the reviewed patch anchors.
"""
import hashlib
from pathlib import Path
import sys

root = Path(sys.argv[1])
schema = root / "server/schemas.py"
schema_digest = hashlib.sha256(schema.read_bytes()).digest()


def replace_once(filename: str, old: str, new: str) -> None:
    path = root / "server" / filename
    source = path.read_text()
    if source.count(old) != 1:
        raise SystemExit(f"Unexpected v0.1.2 source in {filename}; refusing to patch")
    path.write_text(source.replace(old, new))


replace_once("config.py", "@dataclass(frozen=True)", '''MODEL_PROFILES = {
    "all": ("english", "multilingual", "typed-decisions"),
    "multilingual": ("multilingual",),
    "dual": ("english", "multilingual"),
}


@dataclass(frozen=True)''')
replace_once("config.py", '''        if model_profile not in ("all", "multilingual"):
            raise RuntimeError("LAYA_MODEL_PROFILE must be all or multilingual")''', '''        if model_profile not in MODEL_PROFILES:
            raise RuntimeError("LAYA_MODEL_PROFILE must be all, multilingual or dual")''')
replace_once("laya_adapter.py", "import sys\n", "import sys\n\nfrom .config import MODEL_PROFILES\n")
replace_once("laya_adapter.py", '''        models = {name: str(model_dir / name) for name in ("english", "multilingual", "typed-decisions")}
        self.router = Router(models=models, device=device, max_loaded=max_loaded)''', '''        models = {name: str(model_dir / name) for name in MODEL_PROFILES[model_profile]}
        self.router = Router(models=models, device=device, max_loaded=max_loaded)
        if model_profile == "dual":
            # Router merges built-in checkpoints into the supplied map. Remove
            # the unavailable checkpoint; auto task routing stays disabled.
            self.router.models.pop("typed-decisions", None)''')
replace_once("laya_adapter.py", '''        if self.model_profile == "multilingual":''', '''        if self.model_profile == "dual" and model not in (None, "english", "multilingual"):
            raise ValueError("Model is not available in this image")
        if self.model_profile == "multilingual":''')
replace_once("main.py", "from .config import Settings", "from .config import MODEL_PROFILES, Settings")
replace_once("main.py", '''        with router_lock:
            if "router" not in router_holder:''', '''        if settings.model_profile == "dual" and payload.model not in ("auto", "english", "multilingual"):
            raise error(422, "MODEL_NOT_AVAILABLE", "Only the english and multilingual models are installed")
        with router_lock:
            if "router" not in router_holder:''')
replace_once("main.py", '''        names = ("multilingual",) if settings.model_profile == "multilingual" else ("english", "multilingual", "typed-decisions")''', '''        names = MODEL_PROFILES[settings.model_profile]''')
replace_once("main.py", '''        names = ["auto", "multilingual"] if settings.model_profile == "multilingual" else ["auto", "english", "multilingual", "typed-decisions"]''', '''        names = ["auto", *MODEL_PROFILES[settings.model_profile]]''')

assert hashlib.sha256(schema.read_bytes()).digest() == schema_digest
print("Applied v0.1.2 dual deployment profile; API schemas are unchanged.")
