CREATE INDEX route_assignment_failure_time_id_idx ON route_assignment (occurred_at, ('call:' || decision_id))
  WHERE assignment_status = 'assigned' AND completed_at IS NOT NULL AND outcome IN ('error', 'timeout');
CREATE INDEX route_assignment_project_failure_time_id_idx ON route_assignment (project_id, occurred_at, ('call:' || decision_id))
  WHERE assignment_status = 'assigned' AND completed_at IS NOT NULL AND outcome IN ('error', 'timeout');
CREATE INDEX route_assignment_router_failure_time_id_idx ON route_assignment (router_id, occurred_at, ('call:' || decision_id))
  WHERE assignment_status = 'assigned' AND completed_at IS NOT NULL AND outcome IN ('error', 'timeout');
CREATE INDEX runtime_event_project_time_id_idx ON runtime_event (project_id, occurred_at, id);
DROP INDEX runtime_event_project_time_idx;
DROP INDEX runtime_event_endpoint_error_time_idx;
CREATE INDEX runtime_event_endpoint_error_time_idx ON runtime_event (endpoint_id, occurred_at, request_id, project_id)
  WHERE COALESCE(metadata->>'executionStatus' IN ('error', 'timeout'), false);
DROP INDEX runtime_event_endpoint_time_idx;
CREATE INDEX runtime_event_endpoint_time_idx ON runtime_event (endpoint_id, occurred_at, request_id, duration_ms, project_id);
