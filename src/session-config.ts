// ACP session configuration options: the model selector, the reasoning-effort
// selector, and the session mode all arrive as one `configOptions` array on
// `session/new`, and again in full on every change.
//
// This module owns every wire shape and every protocol string in that feature,
// so an ACP v2 bump is a change to this file and nothing else. v2 renames an
// option's `id` to `configId` and makes `type: "id"` required on the set
// request; `parseConfigOptions` already reads either key, and `setRequestBody`
// is the only place the write side would change.
//
// Nothing here imports the ACP SDK. Both payload channels are untrustworthy in
// different ways -- request responses arrive with no validation at all, and
// notifications are validated by a decoder that silently drops items it cannot
// parse -- so every field is treated as unknown and checked here.

// Bounds in the same spirit as MAX_EVENTS and maxResultBytes: the agent controls
// this data, and it is copied into a task record that Claude reads back.
const MAX_OPTIONS = 32;
const MAX_VALUES_PER_OPTION = 128;
const MAX_STRING_LENGTH = 200;

// A change the agent made mid-run is worth one progress event. A chatty or
// hostile agent must not be able to push real progress out of the 200-event
// budget, so tracking continues past this cap but reporting stops.
const MAX_CONFIG_CHANGE_EVENTS = 10;

/** One configuration option as the agent currently reports it. */
export interface ConfigOptionState {
  readonly id: string;
  /** The agent's own display name for the option, or its id when it gave none. */
  readonly label: string;
  readonly currentValue: string;
  /**
   * The agent's own category string, verbatim. Reserved values are `mode`,
   * `model`, `model_config` and `thought_level`, but the spec allows any string
   * and states categories are UX metadata that MUST NOT be required for
   * correctness -- so this is only ever a fallback for finding an option.
   */
  readonly category?: string;
  /** Values the agent offers. Empty for a boolean option, which is never set. */
  readonly values: readonly string[];
}

/** Which option a caller's request is aiming at, most specific signal first. */
export interface ConfigTarget {
  readonly ids: readonly string[];
  readonly categories: readonly string[];
}

export const MODEL_TARGET: ConfigTarget = { ids: ["model"], categories: ["model"] };
export const EFFORT_TARGET: ConfigTarget = { ids: ["thinking"], categories: ["thought_level"] };

export type ConfigResolution =
  | { readonly kind: "apply"; readonly configId: string; readonly value: string }
  | { readonly kind: "already"; readonly configId: string; readonly value: string }
  | {
      readonly kind: "not_offered";
      readonly configId: string;
      readonly currentValue: string;
      readonly offered: readonly string[];
    }
  | { readonly kind: "ambiguous"; readonly configIds: readonly string[] }
  | { readonly kind: "no_option" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown): string | undefined {
  // An over-long id is skipped rather than truncated: a truncated identifier
  // would read as a real one and would not match anything.
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH
    ? value
    : undefined;
}

function parseValues(input: unknown): readonly string[] {
  if (!Array.isArray(input)) return [];
  const values: string[] = [];
  const push = (candidate: unknown): void => {
    const value = boundedString(candidate);
    if (value !== undefined && !values.includes(value)) values.push(value);
  };
  for (const entry of input) {
    if (values.length >= MAX_VALUES_PER_OPTION) break;
    const record = asRecord(entry);
    if (record === undefined) continue;
    // The same field carries either a flat value list or a list of groups, each
    // holding its own values. A model selector grouped by provider is the
    // likeliest real-world shape, and missing this would report every offered
    // model as unavailable.
    const nested = record.options;
    if (Array.isArray(nested)) {
      for (const inner of nested) {
        if (values.length >= MAX_VALUES_PER_OPTION) break;
        push(asRecord(inner)?.value);
      }
      continue;
    }
    push(record.value);
  }
  return values;
}

export function parseConfigOptions(input: unknown): readonly ConfigOptionState[] {
  if (!Array.isArray(input)) return [];
  const parsed: ConfigOptionState[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (parsed.length >= MAX_OPTIONS) break;
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = boundedString(record.id) ?? boundedString(record.configId);
    if (id === undefined || seen.has(id)) continue;

    let currentValue: string | undefined;
    let values: readonly string[] = [];
    if (record.type === "boolean") {
      if (typeof record.currentValue !== "boolean") continue;
      currentValue = record.currentValue ? "true" : "false";
    } else if (record.type === "select" || record.type === undefined || record.type === null) {
      // The stable v1 wire form omits `type` for select options; the SDK's own
      // typings mark it required. Trust the wire, or a compliant agent that
      // omits it becomes invisible.
      currentValue = boundedString(record.currentValue);
      if (currentValue === undefined) continue;
      values = parseValues(record.options);
    } else {
      // An unrecognized type must be ignored, not guessed at.
      continue;
    }

    const category = boundedString(record.category);
    seen.add(id);
    // Agent order is preserved: the spec makes it display priority.
    parsed.push({
      id,
      label: boundedString(record.name) ?? id,
      currentValue,
      ...(category === undefined ? {} : { category }),
      values,
    });
  }
  return parsed;
}

/**
 * Returns the option state carried by a `config_option_update` notification, or
 * `undefined` for any other session update.
 */
export function extractConfigOptions(update: unknown): readonly ConfigOptionState[] | undefined {
  const record = asRecord(update);
  if (record?.sessionUpdate !== "config_option_update") return undefined;
  return parseConfigOptions(record.configOptions);
}

/**
 * One line built only from what the agent said: its own option labels and its
 * own current values. The relay never asserts that any of them is "the model".
 */
export function summarizeConfigOptions(options: readonly ConfigOptionState[]): string {
  return options.map((option) => `${option.label}=${option.currentValue}`).join(", ");
}

export function describeConfigChange(
  before: readonly ConfigOptionState[],
  after: readonly ConfigOptionState[],
): string | undefined {
  const changes: string[] = [];
  for (const option of after) {
    const previous = before.find((candidate) => candidate.id === option.id);
    if (previous === undefined) {
      changes.push(`${option.label} appeared as ${option.currentValue}`);
    } else if (previous.currentValue !== option.currentValue) {
      changes.push(`${option.label} ${previous.currentValue} -> ${option.currentValue}`);
    }
  }
  for (const option of before) {
    // Selecting a model that cannot think removes the effort option outright, so
    // a disappearing option is a real change, not a parse failure.
    if (!after.some((candidate) => candidate.id === option.id)) {
      changes.push(`${option.label} is no longer offered`);
    }
  }
  return changes.length === 0
    ? undefined
    : `Kimi changed its session config: ${changes.join("; ")}`;
}

function matchValue(values: readonly string[], requested: string): string | undefined {
  const wanted = requested.trim();
  if (wanted === "") return undefined;
  if (values.includes(wanted)) return wanted;
  // Model ids are case-sensitive slugs, effort levels are words a human types as
  // "Max". A unique case-insensitive hit is the intent; two hits differing only
  // in case are not guessable.
  const folded = wanted.toLowerCase();
  const candidates = values.filter((value) => value.toLowerCase() === folded);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Resolves a caller's request against the options the agent advertised for this
 * session. The caller's string is only ever a lookup key: what goes on the wire
 * is the agent's own value id, so the relay can never send a configuration value
 * the agent did not offer.
 */
export function resolveConfigRequest(
  options: readonly ConfigOptionState[],
  target: ConfigTarget,
  requested: string,
): ConfigResolution {
  const byId = options.filter((option) => target.ids.includes(option.id));
  const matches =
    byId.length > 0
      ? byId
      : options.filter(
          (option) => option.category !== undefined && target.categories.includes(option.category),
        );
  if (matches.length === 0) return { kind: "no_option" };
  if (matches.length > 1)
    return { kind: "ambiguous", configIds: matches.map((option) => option.id) };
  const option = matches[0];
  if (option === undefined) return { kind: "no_option" };

  const value = matchValue(option.values, requested);
  if (value === undefined) {
    return {
      kind: "not_offered",
      configId: option.id,
      currentValue: option.currentValue,
      offered: option.values,
    };
  }
  return { kind: value === option.currentValue ? "already" : "apply", configId: option.id, value };
}

/**
 * The body of a `session/set_config_option` request, minus the session id.
 *
 * ACP v1 sends a select value with no `type` discriminator: the string branch is
 * the default when `type` is absent, and `type: "select"` is not a v1 wire
 * value. v2 will require `type: "id"` here. This is the only place that changes.
 */
export function setRequestBody(configId: string, value: string): Record<string, string> {
  return { configId, value };
}

/** Tracks the agent's option state across a run and narrates changes to it. */
export class ConfigTracker {
  private current: readonly ConfigOptionState[];
  private emitted = 0;
  private changed = false;

  public constructor(initial: readonly ConfigOptionState[]) {
    this.current = initial;
  }

  public get state(): readonly ConfigOptionState[] {
    return this.current;
  }

  public get changedDuringRun(): boolean {
    return this.changed;
  }

  /**
   * Folds a session update into the tracked state, returning a line to report
   * when it changed something worth telling the user about.
   */
  public observe(update: unknown): string | undefined {
    const next = extractConfigOptions(update);
    if (next === undefined) return undefined;
    // The SDK decodes notifications with a skip-on-error list decoder, so a
    // payload it could not parse arrives here as an empty array. On this channel
    // "the agent has no options" and "the decoder dropped all of them" are
    // indistinguishable, so an empty snapshot never replaces known state. The
    // set-request response and session/new are unvalidated and stay
    // authoritative.
    if (next.length === 0) return undefined;
    const description = describeConfigChange(this.current, next);
    this.current = next;
    if (description === undefined) return undefined;
    this.changed = true;
    if (this.emitted >= MAX_CONFIG_CHANGE_EVENTS) return undefined;
    this.emitted += 1;
    return description;
  }
}
