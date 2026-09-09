import { sql, type SQLWrapper } from "drizzle-orm";

// PostgreSQL expressions missing from Drizzle's built-in operators. Queries
// themselves are composed with Drizzle; these helpers do not execute statements.
export const lowerText = (value: SQLWrapper) => sql<string>`lower(${value})`;
export const jsonText = (value: SQLWrapper, key: string) =>
  sql<string | null>`${value}->>${key}`;
export const increment = (value: SQLWrapper) => sql<number>`${value} + 1`;
export const asText = (value: SQLWrapper) => sql<string>`${value}::text`;
export const timestampValue = (value: string) => sql`${value}::timestamptz`;
export const jsonValue = (value: SQLWrapper, key: string) =>
  sql`${value}->${key}`;
export const jsonArray = (value: SQLWrapper) =>
  sql`CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END`;
export const jsonArrayLength = (value: SQLWrapper) =>
  sql<number>`jsonb_array_length(${jsonArray(value)})`;
export function jsonElements(value: SQLWrapper, name: string) {
  return {
    source: sql`jsonb_array_elements(${jsonArray(value)}) AS ${sql.identifier(name)}`,
    item: sql`${sql.identifier(name)}`,
  };
}
export const jsonObject = (values: Record<string, SQLWrapper>) =>
  sql<Record<string, unknown>>`jsonb_build_object(${sql.join(
    Object.entries(values).flatMap(([key, value]) => [
      sql`${key}::text`,
      sql`${value}`,
    ]),
    sql`, `,
  )})`;
export const jsonAggregate = (value: SQLWrapper) =>
  sql`coalesce(jsonb_agg(${value}), '[]'::jsonb)`;
export const scalar = <T>(query: SQLWrapper) => sql<T>`(${query})`;
export const findingSeverity = (finding: SQLWrapper) => sql<string>`CASE
  WHEN ${jsonText(finding, "verdict")}='error' THEN 'critical'
  WHEN ${jsonText(finding, "verdict")}='unsafe' AND CASE WHEN jsonb_typeof(${jsonValue(finding, "confidence")})='number' THEN (${jsonText(finding, "confidence")})::float8 >= .9 ELSE false END THEN 'high'
  WHEN ${jsonText(finding, "verdict")}='unsafe' OR CASE WHEN jsonb_typeof(${jsonValue(finding, "confidence")})='number' THEN (${jsonText(finding, "confidence")})::float8 >= .7 ELSE false END THEN 'medium'
  ELSE 'low' END`;
export const literal = <T extends string | number>(value: T) =>
  sql<T>`${value}`;
export const coalesce = <T>(...values: SQLWrapper[]) =>
  sql<T>`coalesce(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
export const choose = <T>(
  condition: SQLWrapper,
  yes: SQLWrapper,
  no: SQLWrapper,
) => sql<T>`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`;
export const numericJson = (value: SQLWrapper, key: string) =>
  sql<
    number | null
  >`CASE WHEN jsonb_typeof(${jsonValue(value, key)})='number' THEN (${jsonText(value, key)})::double precision END`;
export const countWhere = (condition: SQLWrapper) =>
  sql<number>`count(*) FILTER (WHERE ${condition})`.mapWith(Number);
export const distinctCountWhere = (value: SQLWrapper, condition: SQLWrapper) =>
  sql<number>`count(DISTINCT ${value}) FILTER (WHERE ${condition})`.mapWith(
    Number,
  );
export const percentiles = (value: SQLWrapper) =>
  sql<
    number[]
  >`percentile_disc(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY ${value})`;
export const distinctArray = (value: SQLWrapper) =>
  sql<string[]>`array_remove(array_agg(DISTINCT ${value}),NULL)`;
export const jsonArrayKey = (...values: SQLWrapper[]) =>
  sql<string>`jsonb_build_array(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})::text`;
export const timeBucket = (value: SQLWrapper, step: number) =>
  sql<number>`(floor(extract(epoch from ${value})*1000/${step})*${step})::bigint`;
// Keep tuple comparisons intact so keyset pagination can seek into the composite index.
export const rowValue = (...values: SQLWrapper[]) =>
  sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
