/** A complete, copyable shell command that never includes an Endpoint secret. */
export function scanRequestCommand(endpointUrl: string, credentialRequired = true): string {
  const quotedUrl = `'${endpointUrl.replaceAll("'", "'\\''")}'`;
  return [
    "curl --request POST \\",
    `  ${quotedUrl} \\`,
    ...(credentialRequired ? ["  --header 'Authorization: Bearer <CALYPSOAI_TOKEN>' \\"] : []),
    "  --header 'Content-Type: application/json' \\",
    "  --data '{",
    '    "input": "Hello, can you help me?",',
    '    "scanDirection": "request",',
    '    "verbose": false',
    "  }'",
  ].join("\n");
}
