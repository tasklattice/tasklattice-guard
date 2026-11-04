// Browser-memory context only. A header is an expected selection, never an
// authorization grant; the server compares it to the current persisted session.
let activeProjectId: string | null = null;
export const currentProjectId = () => activeProjectId;
export const setCurrentProjectId = (id: string | null) => { activeProjectId = id; };
