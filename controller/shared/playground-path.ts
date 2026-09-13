import { z } from "zod";
import { routingInputSchema, sensitiveHeaders } from "./traffic-routing.js";

export const pathTestSchema = z
  .object({
    target: z.enum(["router", "endpoint"]),
    targetId: z.string().min(1).max(128),
    configuration: z.enum(["published", "draft"]).default("published"),
    expectedRevision: z.number().int().positive().optional(),
    action: z.enum(["simulate", "execute"]).default("simulate"),
    endpointId: z.string().max(128).default(""),
    request: z.string().min(1).max(65536),
    credential: z.string().max(4096).default(""),
    callId: z.string().min(1).max(256),
    fields: routingInputSchema.shape.fields.default({}),
    endpointRequest: routingInputSchema.shape.endpoint_request,
  })
  .strict();
export type PathTestInput = z.output<typeof pathTestSchema>;
export type PathTestResult = {
  target: "router" | "endpoint";
  source: "runner" | "controller-draft";
  status: number;
  durationMs: number;
  callId: string;
  body: Record<string, unknown>;
};
export type ParsedHttpRequest = {
  method: string;
  path: string;
  headers: Record<string, string[]>;
  body: string;
};

/** Parse text only. Never execute curl or fetch the supplied host. */
export function parseHttpRequest(source: string): ParsedHttpRequest {
  if (/^curl\s/.test(source.trim())) return parseCurl(source.trim());
  const normalized = source.replace(/\r\n/g, "\n");
  const boundary = normalized.indexOf("\n\n");
  const head = boundary < 0 ? normalized : normalized.slice(0, boundary);
  const lines = head.split("\n");
  const match =
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/(?:1\.[01]|2(?:\.0)?)$/.exec(
      lines.shift()?.trim() ?? "",
    );
  if (!match)
    throw new Error(
      "Use an HTTP request line, for example POST /v1/chat HTTP/1.1, or paste curl.",
    );
  const headers: Record<string, string[]> = Object.create(null);
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9a-z-]+):[ \t]*(.*)$/i.exec(line);
    if (!header) throw new Error("Invalid HTTP header. Use Name: value.");
    const name = header[1]!.toLowerCase();
    (headers[name] ??= []).push(header[2]!);
  }
  const url = new URL(match[2]!, "http://request.invalid");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP URL without credentials.");
  if (/^https?:\/\//.test(match[2]!) && !headers.host)
    headers.host = [url.host];
  return {
    method: match[1]!,
    path: url.pathname + url.search,
    headers,
    body: boundary < 0 ? "" : normalized.slice(boundary + 2),
  };
}
function parseCurl(source: string): ParsedHttpRequest {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\" && quote !== "'") {
      if (source[i + 1] === "\n") {
        i++;
        continue;
      }
      if (!source[i + 1]) throw new Error("Incomplete curl escape.");
      word += source[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed curl quote.");
  if (started) words.push(word);
  words.shift();
  let method = "",
    url = "",
    body = "";
  const headers: string[] = [];
  while (words.length) {
    const option = words.shift()!;
    if (
      [
        "-X",
        "--request",
        "-H",
        "--header",
        "-d",
        "--data",
        "--data-raw",
        "--data-binary",
        "--url",
      ].includes(option)
    ) {
      const value = words.shift();
      if (value === undefined) throw new Error(`Missing value for ${option}.`);
      if (["-X", "--request"].includes(option)) method = value.toUpperCase();
      else if (["-H", "--header"].includes(option)) headers.push(value);
      else if (option === "--url") url = value;
      else {
        if (value.startsWith("@") && option !== "--data-raw")
          throw new Error(
            "File uploads are not supported. Paste the body directly.",
          );
        body = value;
      }
    } else if (["--compressed", "-s", "--silent"].includes(option)) continue;
    else if (/^https?:\/\//.test(option) && !url) url = option;
    else
      throw new Error(
        `Unsupported curl option: ${option}. Use HTTP text for this request.`,
      );
  }
  if (!url) throw new Error("curl requires an HTTP URL.");
  return parseHttpRequest(
    `${method || (body ? "POST" : "GET")} ${url} HTTP/1.1\n${headers.join("\n")}${headers.length ? "\n" : ""}\n${body}`,
  );
}
export function requestSource(
  request: ParsedHttpRequest,
): Record<string, string[]> {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([key]) => !sensitiveHeaders.has(key),
    ),
  );
  let host = "";
  try {
    host = headers.host?.[0]
      ? new URL(`http://${headers.host[0]}`).hostname
      : "";
  } catch {
    throw new Error("Invalid Host header.");
  }
  return {
    ...headers,
    ":method": [request.method],
    ":path": [request.path.split("?")[0]!],
    ":host": [host],
  };
}
export function redactHttpRequest(source: string): string {
  try {
    const parsed = parseHttpRequest(source);
    return `${parsed.method} ${parsed.path} HTTP/1.1\n${Object.entries(
      parsed.headers,
    )
      .map(([k, values]) =>
        values
          .map((v) => `${k}: ${sensitiveHeaders.has(k) ? "[redacted]" : v}`)
          .join("\n"),
      )
      .join("\n")}\n\n${parsed.body}`;
  } catch {
    return "[Request could not be parsed]";
  }
}
