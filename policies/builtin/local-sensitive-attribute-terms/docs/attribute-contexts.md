# Sensitive attribute terms 1.0.0

Both disability Rules now treat the ambiguous abbreviation `ADD` as case sensitive even though other terms are matched without case sensitivity. Ordinary `add` and `Add` verbs are preserved. Uppercase `ADD` and the expanded attention-deficit disorder name remain detected. This vocabulary filter still intentionally redacts benign attribute mentions; it is not a medical diagnosis detector. Uppercase `ADD` remains lexically ambiguous, so applications that require contextual PII classification should use a semantic Policy rather than this optional vocabulary filter.

Existing published artifacts remain frozen. New drafts must explicitly select version 1.0.0.
