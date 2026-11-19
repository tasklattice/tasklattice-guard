# Laya CPU 推理检查

2026-11-18 在本机 ARM64 Linux 容器中检查了默认 Runner 的实际 checkpoint。Laya 使用 `torch 2.6.0+cpu`、CPU 设备、FP32 和 eval 模式，前向计算未启用梯度。锁定的 ONNX 候选包使用 `CPUExecutionProvider`，intra-op 线程跟随相同预算，inter-op 为 1。

默认初判自动使用内置 Laya，包含内容安全输入/输出、越狱输入、Topic Control 输入和语义 PII 输入/输出。复核配置不改变其 CPU 推理路径。

同一请求中独立的初判可以共享一次前向，具体边界、阈值核对与实测见 [合批初判](laya-batched-inference.md)。

## 发现与修复

原实现只在推理工作线程中调用 `torch.set_num_threads()`。本机 ARM wheel 使用 OpenBLAS，并加载原生 OpenMP 运行时；原生新线程的默认值没有统一跟随 Laya 预算。配置 2 个 Torch 线程时，实测进程仍平均使用约 3.20 核。

现在在 NeMo/Torch 加载前设置 OpenMP、MKL、OpenBLAS 的线程默认值，再在模型加载及工作线程初始化时对已经加载的原生池应用同一预算。线程限制在整个运行期间保持，不在并发请求间反复设置与恢复。启动日志 `runner_builtin_laya_loaded` 包含设备、推理并发、intra-op 线程数及各原生池线程数。

预算取 CPU affinity、cgroup quota 与 `GUARD_RUNNER_CPU_MILLICORES` 的较小值，再除以 `GUARD_BUILTIN_LAYA_INFERENCE_CONCURRENCY`，向下取整，至少 1 个线程、最多 64 个。显式的 `GUARD_BUILTIN_LAYA_TORCH_THREADS` 覆盖自动值。默认仍是一个工作线程。

PyTorch 的 [intra-op 线程设置](https://docs.pytorch.org/docs/stable/generated/torch.set_num_threads.html) 和 [线程环境变量](https://docs.pytorch.org/docs/stable/threading_environment_variables.html) 有各自作用范围；[OpenBLAS 的 OpenMP 构建](https://www.openmathlib.org/OpenBLAS/docs/runtime_variables/) 使用 OpenMP 环境变量。运行时使用锁定的 [threadpoolctl](https://github.com/joblib/threadpoolctl/tree/3.6.0) 管理已加载的原生库。

## 本机实测

环境为 4 核 ARM64、6 GiB 内存上限、Laya `0.3.22`、checkpoint `85cc74ddae6109077ebe2853a9b3077fb6606a78`。在同一 Runner 镜像上只读挂载当前源码及锁定依赖，关闭网络，未修改已运行的服务。

每组预热后执行 24 次原生推理，轮换两个短文本和一个较长的客服文本，每次两个 Noul 问题，平均 263 个输入 token。CPU 核数为进程 CPU 时间除以墙钟时间；不包含模型加载。原始记录见 [benchmark JSON](laya-cpu-inference-benchmark.json)。

| 配置 | 平均使用核数 | 吞吐（请求/秒） |
| --- | ---: | ---: |
| 原实现：1 worker × 2 threads | 3.20 | 1.24 |
| 修复后：2 核预算，1 worker × 2 threads | 1.98 | 0.77 |
| 修复后：4 核预算，1 worker × 4 threads | 3.73 | 1.43 |
| 修复后：2 核预算，2 workers × 1 thread | 1.23 | 0.49 |

默认单 worker 实际使用约 99% 的 2 核预算；提高到 4 核预算后使用约 93% 的 4 核。原实现较高的吞吐伴随超过 2 核预算的 CPU 占用。当前部署的预算是 2000 millicores；需要更多 CPU 时应提高 Runner 的资源预算。上述两 worker 配置在本机吞吐降低，因此保持单 worker 默认。

脚本检查真实前向设备、线程数、eval 和梯度状态、响应结构及输入覆盖，并核对重复样本的答案一致性。这些数据描述本机原生推理，不代表 Policy 检测质量或带排队、网络及复核的端到端延迟。

## 复现

使用包含当前改动的 Runner 镜像，模型目录沿用镜像内配置。分别用新容器运行各组，避免多个压测争用 CPU：

```sh
docker run --rm -i --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 4 --memory 6g \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e GUARD_RUNNER_CPU_MILLICORES=2000 \
  --entrypoint python "$RUNNER_IMAGE" - --concurrency 1 --requests 24 \
  < scripts/benchmark_laya_cpu.py
```

将预算改为 `4000` 验证四核，或设置 `--concurrency 2` 比较并发。脚本也支持 `--threads` 显式覆盖每个工作线程的预算。修改 CPU 默认值需重新构建并滚动更新 Runner；仅更新 Controller 不会改变已有进程的原生线程默认值。
