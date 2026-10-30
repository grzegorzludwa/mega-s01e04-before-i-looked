/** Status of one valid log event, rather than an aggregate job outcome. */
export type RunStatus = 'ok' | 'retry' | 'fail';

/** Counts of valid events; a job can contribute to more than one status. */
export type StatusCounts = Record<RunStatus, number>;

/** One job's events, aggregated in their original file order. */
export type DigestRow = {
  job: string;
  /** Owner from the last event, including an explicit null. */
  owner: string | null;
  /** All valid events for this job, including retry and fail events. */
  runs: number;
  retries: number;
  /** All fail events, so a later success cannot hide an earlier failure. */
  failures: number;
  lastStatus: RunStatus;
  /** Most recently supplied error string; success does not clear it. */
  lastError: string | null;
  /** Original timestamp strings from the first and last events in file order. */
  firstAt: string;
  lastAt: string;
};

/** A file that exists, even when it is empty or every line is malformed. */
export type NightDigest = {
  night: string;
  /** One row per job, ascending by case-sensitive JS string comparison. */
  rows: DigestRow[];
  /** Nonblank lines rejected as malformed JSON or invalid event objects. */
  badLines: number;
  /** Event counts across the whole file, excluding malformed lines. */
  counts: StatusCounts;
};

/** Null means no file (or an invalid night identifier), never an empty file. */
export type NightResult = NightDigest | null;

/**
 * Read runsDir/<night>.jsonl. The implementation belongs in digest/read.ts.
 *
 * Accept only night identifiers matching YYYY-MM-DD; reject anything else with
 * null before accessing disk. A missing file (ENOENT) returns null. Other I/O
 * failures reject the promise rather than masquerading as a missing night.
 *
 * Ignore whitespace-only lines, including the final newline. Each other line
 * must be a JSON object with a nonempty string job, an ISO 8601 timestamp at
 * with an explicit offset (Z is allowed), a RunStatus status, an owner that is
 * a string or null, and an optional string error. Extra fields are ignored.
 * Invalid JSON or invalid fields count as one bad line and contribute no data.
 *
 * Aggregate valid events in file order, not timestamp order; equal or out-of-
 * order timestamps do not reorder events. Preserve timestamp strings and null
 * owners exactly. An absent error leaves the preceding lastError intact; if
 * no event supplies an error, lastError is null. Each row's runs equals its event
 * count; retries and failures count their respective statuses. Sum(counts)
 * equals Sum(rows[].runs). Rows are sorted by job, without locale collation.
 *
 * An empty file returns { night, rows: [], badLines: 0,
 * counts: { ok: 0, retry: 0, fail: 0 } }. An all-malformed file has empty rows
 * and zero counts too, but retains its badLines count. Page and JSON consumers
 * use this same result, including its row order and retained error details.
 */
export type ReadNight = (runsDir: string, night: string) => Promise<NightResult>;
