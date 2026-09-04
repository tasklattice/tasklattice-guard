UPDATE "model_provider"
SET
	"status" = 'pending',
	"validation_message" = 'Provider credential must be verified by an actual Model call.',
	"validation_latency_ms" = NULL,
	"validated_at" = NULL,
	"updated_at" = NOW()
WHERE
	"status" = 'validated'
	AND "validation_message" LIKE 'Provider connected and returned %';
