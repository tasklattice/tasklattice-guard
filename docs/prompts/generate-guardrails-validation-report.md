# Task: Generate a Customer-Facing GuardRails Safety & Performance Validation Report

You are working inside the **TaskLattice GuardRails** repository.

Your task is to generate a polished, professional, enterprise-grade PDF report that demonstrates the product's **security effectiveness, detection quality, utility preservation, performance overhead, cost efficiency, and engineering validation methodology**.

The output should look like a document that could realistically be delivered to:

* Bank security teams
* Enterprise architecture teams
* AI governance teams
* Risk and compliance teams
* Procurement / technical due-diligence teams
* Internal release review boards

The report must NOT present TaskLattice as providing perfect safety or 100% detection.

The central message of the report is:

> GuardRails effectiveness is a measurable trade-off between residual safety risk, false positives, application utility, end-to-end latency, throughput, and operating cost.

The purpose of the document is to show that TaskLattice evaluates those trade-offs systematically and reproducibly.

---

# 1. Deliverables

Generate:

1. `TaskLattice_GuardRails_Safety_Performance_Validation_Report.pdf`
2. Preferably also generate an editable source:

   * `.docx`, `.html`, `.md`, `.typ`, `.tex`, or equivalent
3. Store any generated charts/assets under an appropriate report assets directory.
4. Keep the source reproducible so the report can later be generated automatically by CI/CD.

The final PDF should ideally be approximately **10–15 pages**.

Target page count:

> 12 pages is a good default.

Use A4 portrait orientation unless there is a strong reason otherwise.

---

# 2. Critical Data Integrity Rule

This is currently a **sample / reference report**, not an actual independently certified benchmark result.

Therefore:

Any fabricated or example product performance figures MUST be visibly labeled:

> Illustrative Sample Results — Not a Certification

or:

> Sample results shown for report design purposes only.

Do NOT imply that:

* TaskLattice has passed an external certification
* MLCommons certified the product
* NVIDIA certified the product
* NIST certified the product
* ISO certified the product
* benchmark numbers shown are real production measurements

Public framework descriptions may be factual.

Product benchmark numbers may be realistic but illustrative.

Never invent external endorsements.

---

# 3. Product Context

The product is:

**TaskLattice GuardRails**

TaskLattice GuardRails is an enterprise AI safety gateway positioned between applications / AI gateways and downstream large language models.

Typical traffic flow:

Client / Application
→ API Gateway / LiteLLM
→ TaskLattice GuardRails
→ LLM
→ Output GuardRails
→ Client

The architecture may include:

* Input Guardrails
* Output Guardrails
* Content Safety
* Jailbreak Detection
* Prompt Injection Detection
* Topic Control
* Sensitive Data / PII Detection
* Rule-based filters
* Regex / deterministic checks
* Small safety classifiers
* Escalation to larger judge models
* Policy routing
* GuardRails versions / revisions
* Customer-specific banking policies

The product is inspired by and may integrate with **NVIDIA NeMo Guardrails**, but TaskLattice GuardRails itself is a separate product.

The report should therefore distinguish:

* NeMo Guardrails methodology / ecosystem
* NVIDIA safety models
* TaskLattice orchestration / policies / product behavior

---

# 4. Main Evaluation Philosophy

Do NOT reduce GuardRails evaluation to a single "Accuracy" score.

The report must explicitly explain why overall accuracy is insufficient.

For GuardRails, evaluate at least five dimensions:

## A. Safety Effectiveness

Examples:

* Attack Success Rate — ASR
* Violation Rate
* Unsafe Request Detection Rate
* Unsafe Response Detection Rate

Core metric:

ASR = Successful attacks / Total attempted attacks

Lower is better.

Where possible compare:

* Baseline LLM
* Guarded LLM

Example:

Baseline ASR: 42.6%

Guarded ASR: 3.8%

Relative ASR Reduction: 91.1%

Numbers may vary, but should be realistic.

---

## B. Detection Quality

Use standard classification metrics:

TP = unsafe correctly blocked
TN = benign correctly allowed
FP = benign incorrectly blocked
FN = unsafe incorrectly allowed

Report:

Precision = TP / (TP + FP)

Recall / TPR = TP / (TP + FN)

False Negative Rate = FN / (TP + FN)

False Positive Rate = FP / (FP + TN)

F1 score where relevant.

The report should emphasize:

> False Negative Rate represents residual unsafe traffic.

and:

> False Positive Rate represents business disruption / over-blocking.

---

## C. Utility Preservation

Measure how much legitimate traffic continues to work correctly.

Metrics:

* Benign Pass Rate
* Over-refusal Rate
* False Positive Rate

Example:

Benign Pass Rate: 98.4%

False Positive Rate: 1.6%

Explain why a system that blocks every request could achieve excellent safety but has zero business value.

Safety must therefore always be interpreted together with utility.

---

## D. Performance

Measure GuardRails overhead separately from base model latency.

Report:

* p50 latency
* p95 latency
* p99 latency
* GuardRails latency delta
* Throughput / QPS
* Throughput degradation
* Optional CPU / GPU utilization

Example comparison:

LLM only:
p50: 610 ms
p95: 1420 ms
p99: 2150 ms

Guarded:
p50: 710 ms
p95: 1660 ms
p99: 2490 ms

GuardRails p95 overhead:
+240 ms

Use realistic values.

---

## E. Cost Efficiency

Report:

* Guardrail cost / request
* Guardrail cost / 1,000 requests
* Token overhead
* Model invocation count
* Escalation rate
* Optional GPU inference utilization

Show that enabling every policy does not necessarily create an optimal configuration.

Example:

Basic:
$0.05 / 1K requests

Standard:
$0.31 / 1K requests

Advanced:
$0.62 / 1K requests

Strict:
$1.43 / 1K requests

These are illustrative.

---

# 5. Public Methodologies and Benchmarks

The report should reference recognized industry engineering practices and public benchmarks.

Use current official sources where possible.

At minimum cover:

## NVIDIA NeMo Guardrails

Reference its evaluation methodology around:

* policy compliance
* configuration evaluation
* resource usage
* latency
* testing Guardrails configurations
* deterministic / regression testing
* LLM-as-a-Judge with human validation where applicable

Explain that configuration-level evaluation is not just model accuracy.

---

## NVIDIA Garak

Describe Garak as an LLM vulnerability scanner / red-team tool.

Use it for areas such as:

* jailbreak
* prompt injection
* encoding / obfuscation
* harmful generation
* leakage
* adversarial probes

Important limitation:

Do NOT treat scores from different Garak probe families as a universally normalized comparable safety score.

Use Garak primarily for:

* baseline vs guarded comparison
* version-to-version regression
* identifying vulnerability classes

---

## NVIDIA Aegis / Nemotron Safety Dataset

Use as a public content safety reference dataset.

Use it to evaluate:

* harmful content detection
* benign content handling
* classification quality

Metrics:

Precision
Recall
F1
FPR
FNR

---

## HarmBench

Use for:

* adversarial robustness
* automated red teaming
* harmful behavior testing
* Attack Success Rate

Report Guarded vs Baseline ASR.

---

## JailbreakBench

Use as a fixed jailbreak benchmark suitable for:

* release regression
* defense evaluation
* stable comparison between GuardRails revisions

---

## WildJailbreak

Optionally use it for:

* adversarial harmful prompts
* adversarial benign prompts
* real-world jailbreak patterns
* over-blocking analysis

---

## XSTest

Use specifically for:

* exaggerated safety behavior
* over-refusal
* benign prompts containing apparently sensitive concepts

This dataset is especially useful to demonstrate that stronger GuardRails do not simply block more legitimate requests.

---

## CantTalkAboutThis / NVIDIA Topic Control evaluation

Use for:

* topic control
* on-topic/off-topic classification
* multi-turn conversation boundary enforcement

For TaskLattice Banking GuardRails, supplement it with a customer/domain-specific Banking Golden Set.

---

# 6. Evaluation Dataset Structure

Explain that a mature GuardRails evaluation should use three layers of test data.

## Layer 1 — Public Standard Benchmarks

Examples:

* Aegis / Nemotron safety
* HarmBench
* JailbreakBench
* WildJailbreak
* XSTest
* CantTalkAboutThis

Purpose:

Avoid purely self-authored evaluation.

---

## Layer 2 — TaskLattice Golden Set

TaskLattice-maintained regression dataset.

Must contain:

* known harmful examples
* known benign examples
* edge cases
* ambiguous requests
* adversarial wording
* multilingual examples where relevant
* prompt injection
* encoded attack variants
* policy conflicts
* multi-turn cases

This dataset should be version controlled.

Example:

`evaluation/datasets/tasklattice-golden-v1.jsonl`

---

## Layer 3 — Customer Domain Golden Set

For a banking customer include examples such as:

* account information
* transfer limits
* fraud / scam discussion
* personal information
* credit card handling
* investment topics
* customer complaint
* internal-only knowledge
* regulatory text
* off-topic requests
* benign cybersecurity questions
* adversarial requests using banking terminology

Clearly distinguish domain validation from generic public benchmark results.

---

# 7. Required Report Structure

Produce a polished report using roughly the following structure.

---

## Page 1 — Cover

Title:

**TaskLattice GuardRails**

Subtitle:

**Safety, Robustness & Performance Validation Report**

Include:

* Product version
* Evaluation profile
* Report version
* Date
* Classification, e.g. "Customer Evaluation Sample"
* Disclaimer:

  Illustrative Sample Results — Not a Certification

Visual style:

* premium enterprise
* modern security / AI infrastructure aesthetic
* restrained
* no playful graphics
* dark navy / graphite / white with subtle cyan or blue accents
* generous whitespace
* minimal gradients
* high-quality typography

---

## Page 2 — Executive Summary

Include 5–8 top-level KPI cards.

Example metrics:

Attack Success Rate:
3.8%

Baseline ASR:
42.6%

Relative ASR Reduction:
91.1%

Unsafe Recall:
97.4%

False Positive Rate:
1.5%

Benign Pass Rate:
98.5%

p95 GuardRails Overhead:
+230 ms

Cost / 1K Requests:
$0.41

Also include a short executive interpretation:

TaskLattice GuardRails materially reduces successful adversarial behavior while maintaining high legitimate-request availability. Stronger policy profiles provide diminishing safety returns and increasing latency/cost, so profile selection should be risk-based rather than policy-count based.

Clearly label numbers as illustrative.

---

## Page 3 — Scope and System Under Test

Show architecture diagram:

Client
→ Gateway
→ Input GuardRails
→ LLM
→ Output GuardRails
→ Response

Show optional internal stages:

Stage 1:
Deterministic filters / regex

Stage 2:
Small safety classifiers

Stage 3:
Advanced judge / escalation model

Clearly define the SUT boundary.

Document example test environment:

* GuardRails version
* policy revision
* target LLM
* safety model
* jailbreak model
* topic-control model
* concurrency
* dataset revision
* hardware
* region
* request timeout
* temperature

Use realistic sample values.

---

## Page 4 — Evaluation Methodology

Describe four test layers:

1. Unit / deterministic regression
2. Public benchmark evaluation
3. Dynamic red-team / Garak scanning
4. End-to-end performance testing

Show a pipeline diagram.

Include the five main evaluation dimensions:

Safety
Detection Quality
Utility
Performance
Cost

Explain TP/TN/FP/FN.

---

## Page 5 — Benchmark Coverage Matrix

Create a professional table such as:

Capability | Benchmark | Metric | Role

Content Safety | NVIDIA Aegis/Nemotron | Precision/Recall/FPR/FNR | Classification quality

Jailbreak | JailbreakBench | ASR | Stable release benchmark

Adversarial robustness | HarmBench | ASR | Red-team behavior

Real-world jailbreak | WildJailbreak | ASR / benign refusal | Real-world robustness

Over-refusal | XSTest | refusal rate / FPR | Utility preservation

Topic Control | CantTalkAboutThis | Precision/Recall/F1 | Scope enforcement

Dynamic attacks | NVIDIA Garak | probe-specific results | Vulnerability discovery

Banking policies | TaskLattice Banking Golden Set | policy compliance | Domain acceptance

---

## Page 6 — Safety Effectiveness Results

Show one or more charts.

Primary chart:

Baseline ASR vs Guarded ASR.

Example:

Baseline:
42.6%

Basic:
14.7%

Standard:
6.9%

Advanced:
3.8%

Strict:
2.9%

Explain:

Additional policies continue to reduce ASR, but marginal benefits become smaller while latency and cost increase.

Include attack-family breakdown if space permits:

* Direct jailbreak
* Obfuscated jailbreak
* Prompt injection
* Encoding attacks
* Multi-turn jailbreak

---

## Page 7 — Detection Quality & Utility

Include confusion matrix and metrics.

Sample:

Unsafe Recall:
97.4%

Precision:
96.8%

FNR:
2.6%

FPR:
1.5%

Benign Pass Rate:
98.5%

Include XSTest / benign adversarial examples.

Show at least one table comparing safety and utility.

Example:

Profile | Unsafe Recall | Benign Pass | FPR

Basic | 89.7% | 99.6% | 0.4%

Standard | 95.8% | 99.0% | 1.0%

Advanced | 97.4% | 98.5% | 1.5%

Strict | 98.2% | 94.1% | 5.9%

This is illustrative.

Explain why "Strict" is not universally the best profile.

---

## Page 8 — Garak / Adversarial Scan

Present representative Garak categories.

For example:

* DAN-style jailbreak
* Encoding
* Prompt injection
* Leakage
* Toxicity
* Obfuscation

Show:

Baseline vs Guarded results.

Do NOT present a fabricated universal "Garak Safety Score".

Explain:

Probe results are most useful for controlled comparison under the same probe set and target configuration.

Include key findings:

* direct jailbreak substantially reduced
* encoded attack remains a harder class
* prompt injection improved
* residual risk remains

---

## Page 9 — Performance

Charts should show:

p50
p95
p99

for:

* LLM only
* Basic
* Standard
* Advanced
* Strict

Also show:

* GuardRails-only overhead
* QPS impact
* concurrency used

Example:

Profile | p95 | Δp95 | Throughput impact

Baseline | 1.42s | — | —

Basic | 1.47s | +50ms | -1.2%

Standard | 1.55s | +130ms | -2.9%

Advanced | 1.66s | +240ms | -4.8%

Strict | 2.01s | +590ms | -11.8%

Clearly mark illustrative.

---

## Page 10 — Cost & Pareto Analysis

Show cost per 1,000 requests.

Also show a scatter chart:

X-axis:
p95 latency overhead or cost

Y-axis:
Safety effectiveness / ASR reduction

Points:

Basic
Standard
Advanced
Strict

Highlight a Pareto frontier concept.

Do NOT label one option as universally "best".

Explain:

Profile selection should follow the customer's risk appetite, workload latency SLO, cost budget, and false-positive tolerance.

Also show an optional policy ablation table:

Policy | Safety Gain | p95 Cost | Dollar Cost | FP Impact

Regex | small | negligible | negligible | low

Content Safety | high | moderate | moderate | low

Jailbreak | high | moderate | moderate | low

Topic Control | domain dependent | moderate | moderate | moderate

Large Judge | incremental | high | high | moderate

---

## Page 11 — Release Qualification & Engineering Practice

Show CI/CD release gate:

GuardRails Revision
↓
Unit Tests
↓
Golden Set
↓
Public Benchmarks
↓
Garak
↓
Performance Benchmark
↓
Release Gate
↓
Signed Evaluation Artifact

Define example release gates:

* Unsafe Recall ≥ 96%
* FPR ≤ 2%
* Benign Pass Rate ≥ 98%
* Jailbreak ASR ≤ 5%
* p95 GuardRails overhead ≤ 300 ms
* no critical regression vs previous revision

These thresholds are example policy values, not external standards.

Show what must be version-pinned:

* GuardRails source commit
* policy revision
* model name/version
* benchmark dataset revision
* judge model
* runtime image
* prompt templates
* configuration
* random seed where applicable

---

## Page 12 — Limitations, Customer Acceptance & References

Clearly state limitations:

* No GuardRails can guarantee prevention of all adversarial attacks.
* Results are distribution-dependent.
* Public benchmarks do not fully represent customer production traffic.
* Adaptive attackers may discover unknown attack paths.
* Safety classifiers may generate both false positives and false negatives.
* Changes to models, prompts, policies, datasets or runtime invalidate previous measurements.
* Customer-specific acceptance testing remains required.

Include a "Recommended Customer Acceptance Test":

Public Benchmark
+
TaskLattice Golden Set
+
Customer Banking Golden Set
+
Production-like load testing

Include references to official or primary sources.

---

# 8. Required Charts

Create at least four polished charts.

Recommended:

1. Attack Success Rate by profile
2. End-to-end latency by profile
3. Safety / latency or safety / cost Pareto chart
4. Garak baseline vs guarded comparison

Optional:

5. False-positive / utility chart
6. Policy ablation chart

Charts should use a consistent visual language.

Avoid rainbow colors.

Prefer neutral enterprise styling.

Make charts readable in print.

---

# 9. Writing Style

Tone:

* formal
* technical
* concise
* auditable
* risk-aware
* enterprise security engineering

Avoid marketing exaggeration such as:

* industry-leading
* unbreakable
* complete protection
* zero-risk
* guaranteed safety
* 100% secure

Prefer language such as:

* measured
* evaluated
* observed
* reduced
* residual risk
* under the evaluated configuration
* within the tested dataset
* representative sample
* observed trade-off
* release qualification criterion

---

# 10. Engineering Language

Use terminology appropriate for:

* AI security
* LLM evaluation
* model safety
* adversarial testing
* performance engineering
* enterprise release governance

Important terms to use correctly:

* System Under Test (SUT)
* Attack Success Rate (ASR)
* False Positive Rate (FPR)
* False Negative Rate (FNR)
* Precision
* Recall
* F1
* Over-refusal
* Benign Pass Rate
* Residual Risk
* Golden Set
* Regression Test
* Policy Compliance
* Red Team
* GuardRail Revision
* Release Gate
* p50 / p95 / p99
* Throughput
* Pareto Frontier
* Policy Ablation
* LLM-as-a-Judge
* Human Review
* Reproducibility Manifest

---

# 11. Statistics / Confidence

Where useful, include sample counts.

Example:

Jailbreak:
n = 5,000

Benign:
n = 10,000

Topic Control:
n = 2,000

Content Safety:
n = 8,000

Where percentages are reported, optionally include 95% confidence intervals.

Example:

Unsafe Recall:
97.4%

95% CI:
96.9%–97.8%

Do not invent excessive statistical precision.

One decimal place is generally enough for business reporting.

---

# 12. Reproducibility Manifest

Include a small appendix or table containing fields similar to:

Report ID

GuardRails Version

GuardRails Git Commit

Configuration Revision

Policy Bundle Revision

Safety Model

Jailbreak Model

Topic Control Model

Target LLM

Judge Model

Dataset Version

Benchmark Tool Version

Garak Version

Runtime Image

Hardware

Concurrency

Temperature

Seed

Evaluation Timestamp

This is important because the report should eventually become an automatically generated release artifact.

---

# 13. Expected Sample Result Shape

Use realistic illustrative results roughly following this qualitative pattern:

Baseline:

* highest ASR
* best latency
* lowest cost
* no over-blocking from GuardRails

Basic:

* meaningful safety gain
* negligible latency/cost

Standard:

* major safety gain
* small utility/performance impact

Advanced:

* strong enterprise balance
* low ASR
* high benign pass rate
* moderate latency

Strict:

* slightly better safety
* noticeably higher false-positive rate
* significantly higher latency/cost

Do NOT make Strict obviously "the winner".

The report should visually demonstrate diminishing returns.

---

# 14. Example Profile Definitions

You may use:

## Baseline

No TaskLattice GuardRails.

---

## Basic

* deterministic regex
* simple deny rules
* basic PII
* lightweight policy filters

---

## Standard

Basic plus:

* Content Safety model
* Jailbreak Detection
* standard output moderation

---

## Advanced

Standard plus:

* Topic Control
* stronger prompt injection rules
* multi-stage safety classification
* selected escalation

---

## Strict

Advanced plus:

* broader policy coverage
* high-sensitivity thresholds
* large judge escalation
* aggressive multi-stage validation

Again:

These profiles exist to demonstrate trade-offs.

Do not declare one profile universally superior.

---

# 15. Source Quality

When referencing public methodology or benchmark facts, prefer:

1. Official NVIDIA documentation
2. Official NVIDIA GitHub repositories
3. Official benchmark repositories
4. Original academic paper / conference publication
5. Official Hugging Face dataset/model cards

Avoid relying on:

* random blogs
* SEO articles
* vendor marketing summaries when primary sources are available

Potential references include:

* NVIDIA NeMo Guardrails documentation
* NVIDIA Garak
* NVIDIA Aegis / Nemotron Safety datasets
* HarmBench
* JailbreakBench
* WildJailbreak
* XSTest
* CantTalkAboutThis / NVIDIA topic-control resources
* NIST AI RMF / NIST AI 600-1 where methodological context is useful

The document does not need to become a standards survey.

Public references exist to support the engineering methodology.

---

# 16. Visual Design Requirements

The report must look like an enterprise deliverable rather than an academic paper.

Use:

* strong cover
* clear section hierarchy
* KPI cards
* restrained callout panels
* professional tables
* high-quality charts
* page numbers
* header/footer
* report version
* classification label
* consistent spacing

Avoid:

* oversized marketing slogans
* excessive decorative illustrations
* colorful gradients everywhere
* childish iconography
* overly dense academic text
* huge blocks of uninterrupted prose

Preferred design language:

Enterprise AI infrastructure / cybersecurity / cloud platform.

Suggested visual character:

* dark navy
* graphite
* white
* steel gray
* cyan / electric blue accents

However, prioritize readability over decoration.

---

# 17. Quality Assurance Before Final Delivery

Before finishing:

1. Render the PDF.
2. Inspect every page visually.
3. Ensure no:

   * table overflow
   * clipped text
   * broken fonts
   * bad page breaks
   * overlapping elements
   * missing charts
   * blurry graphics
   * orphan headings
4. Verify all metric labels.
5. Verify every illustrative number is labeled appropriately.
6. Verify external references are real.
7. Verify the document never claims external certification.
8. Verify charts and tables use internally consistent numbers.
9. Verify ASR, FPR, FNR, recall and benign-pass calculations are mathematically consistent.
10. Verify PDF opens correctly.

If source generation requires code, keep the implementation clean and reproducible.

---

# 18. Future Automation Compatibility

Design the source so sample data can later be replaced by generated benchmark results.

Prefer separating:

`report template`
from
`evaluation results`

For example:

```text
evaluation/
  datasets/
  results/
    evaluation-summary.json
    latency.json
    garak.json
    benchmark.json

report/
  template/
  assets/
  generate_report.py
```

The eventual goal is:

```text
GuardRails Revision
        ↓
Evaluation Pipeline
        ↓
evaluation-summary.json
        ↓
Report Generator
        ↓
Signed PDF
```

Therefore avoid hard-coding all values directly into page layout code if a structured data model can be used instead.

---

# Final Acceptance Criteria

The task is complete when:

* A polished customer-facing PDF exists.
* The PDF explains product protection capabilities quantitatively.
* It measures safety and false positives together.
* It includes performance and cost.
* It uses recognized public benchmark methodology.
* It includes Garak / red-team evaluation.
* It demonstrates GuardRails policy trade-offs.
* It includes reproducibility metadata.
* It clearly distinguishes illustrative numbers from certified results.
* It would be credible as a technical appendix in a bank procurement or security review.
* The source can later be connected to real CI/CD benchmark output.

Generate the complete report rather than only an outline.
