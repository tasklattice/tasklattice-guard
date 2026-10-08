-- The runtime baseline is an explicit pointer, separate from the Default's Latest.
ALTER TABLE controller_state ADD COLUMN baseline_version text;
