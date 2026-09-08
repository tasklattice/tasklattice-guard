/** Interpret public configuration views without mistaking a rejection for a swap. */
export function restoreAction(view, originalId, attemptedId) {
  if (!originalId || !attemptedId) throw new Error('Pin both original and attempted revisions before restoration.');
  if (view.activating) {
    if (view.activating.id === attemptedId) return 'wait';
    throw new Error('Another activation is in progress; refusing to overwrite it.');
  }
  if (view.active?.id === originalId) return 'unchanged';
  if (view.active?.id === attemptedId) return 'rollback';
  throw new Error('Unexpected active revision; refusing an unrelated rollback.');
}

export function activationRevisionId(view) {
  // POST activate/rollback return { active, activating, failed, ... }, not a revision.
  const id = view.activating?.id ?? view.active?.id;
  if (!id) throw new Error('Activation response has no active or activating revision.');
  return id;
}
