from __future__ import annotations

import copy
import threading

from runner.toolkit.compiler.artifact import ArtifactCompiler
from runner.toolkit.nemo.builtin_policies import prompt_catalog_yaml
from runner.toolkit.nemo.native_models import NativeRailModel

from . import generated as protocol
from .diagnostics import diagnostic_phase


class DefaultRunnerCompiler:
    """Runner adapter that pins live model assignments around the offline compiler."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._native_models: tuple[NativeRailModel, ...] = ()
        self._prompts_yaml = prompt_catalog_yaml()
        self._compiler = ArtifactCompiler(builtin_prompts_yaml=self._prompts_yaml)

    def configure_native_models(self, models: tuple[NativeRailModel, ...]) -> None:
        compiler = ArtifactCompiler(builtin_prompts_yaml=self._prompts_yaml,
                                    model_types=tuple(model.type for model in models))
        with self._lock:
            self._native_models = models
            self._compiler = compiler

    def snapshot(self) -> DefaultRunnerCompiler:
        with self._lock:
            snapshot = copy.copy(self)
            snapshot._lock = threading.RLock()
            return snapshot

    @property
    def native_models(self) -> tuple[NativeRailModel, ...]:
        with self._lock:
            return self._native_models

    @diagnostic_phase("artifact.compile")
    def compile(self, request: protocol.CompileRequest) -> protocol.Artifact:
        with self._lock:
            compiler = self._compiler
        return compiler.compile(request)
