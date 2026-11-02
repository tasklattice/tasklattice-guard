// Regenerate before importing the HTTP app, including on each tsx watch restart.
// Dynamic imports keep the generated JSON available before openapi.ts loads it.
await import('./generate-openapi.mjs');
await import('../server/index.ts');
