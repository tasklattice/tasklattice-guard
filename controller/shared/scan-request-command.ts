/** A complete, copyable shell command that never includes an Endpoint secret. */
export function scanRequestCommand(endpointUrl: string): string {
  const quotedUrl = `'${endpointUrl.replaceAll("'", "'\\''")}'`;
  return [
    "curl --request POST \\",
    `  ${quotedUrl} \\`,
    "  --header 'Authorization: Bearer <CALYPSOAI_TOKEN>' \\",
    "  --header 'Content-Type: application/json' \\",
    "  --data '{",
    '    "input": "Hello, can you help me?",',
    '    "scanDirection": "request",',
    '    "flagOnly": true,',
    '    "verbose": false',
    "  }'",
  ].join("\n");
}
