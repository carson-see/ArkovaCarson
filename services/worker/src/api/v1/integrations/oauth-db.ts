/** Narrow query contracts shared by the OAuth database facades. */
export interface DbQueryResult<T> {
  data: T | null;
  error: unknown;
}

export interface DbFilterQuery<T> extends PromiseLike<DbQueryResult<T>> {
  select(columns?: string): DbFilterQuery<T>;
  eq(field: string, value: unknown): DbFilterQuery<T>;
  is(field: string, value: unknown): DbFilterQuery<T>;
  single(): Promise<DbQueryResult<T extends Array<infer Row> ? Row : T>>;
  maybeSingle(): Promise<DbQueryResult<T extends Array<infer Row> ? Row : T>>;
}
