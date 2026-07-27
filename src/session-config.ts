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

import type { AgentConfigOptionSnapshot, AgentConfigRequestOutcome } from "./types.js";

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

/**
 * The reported projection of the option state: what the agent said, without the
 * lists of values it offered. Those can run to dozens of entries per option and
 * would be copied into every poll of every task.
 */
export function toConfigSnapshot(
  options: readonly ConfigOptionState[],
): readonly AgentConfigOptionSnapshot[] {
  return options.map(({ id, label, currentValue, category }) => ({
    id,
    name: label,
    currentValue,
    ...(category === undefined ? {} : { category }),
  }));
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

/** A caller's request for one configuration option. */
export interface ConfigRequest {
  readonly target: ConfigTarget;
  /** How to name this option in a warning, for example "model". */
  readonly label: string;
  readonly requested: string;
}

export interface AppliedConfig {
  readonly state: readonly ConfigOptionState[];
  readonly outcomes: readonly AgentConfigRequestOutcome[];
  readonly warnings: readonly string[];
}

/** Sends one `session/set_config_option` and resolves with the response's `configOptions`. */
export type SetConfigOption = (configId: string, value: string) => Promise<unknown>;

const METHOD_NOT_FOUND = -32601;

function errorCode(error: unknown): number | undefined {
  const record = asRecord(error);
  return typeof record?.code === "number" ? record.code : undefined;
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code === undefined ? message : `${message} (JSON-RPC ${code})`;
}

/**
 * Applies configuration requests against a live session.
 *
 * Requests are applied strictly in the order given, one at a time, and the whole
 * option state is rebuilt from each response before the next request resolves.
 * That order matters: the agent may rewrite one option's legal values when
 * another changes -- selecting a model that cannot reason removes the effort
 * option outright -- so callers must pass the model request before the effort
 * request. The spec defines no semantics for concurrent set calls, so they are
 * never issued in parallel.
 *
 * No failure here fails the task. A review that ran at the agent's own default
 * and found a real defect is still a good review; losing it because an optional
 * knob would not turn is not a trade worth making.
 */
export async function applyConfigRequests(
  initial: unknown,
  requests: readonly ConfigRequest[],
  setOption: SetConfigOption,
): Promise<AppliedConfig> {
  let state = parseConfigOptions(initial);
  const outcomes: AgentConfigRequestOutcome[] = [];
  const warnings: string[] = [];
  const sent = new Map<string, string>();
  let unsupported = false;

  for (const request of requests) {
    const { label, requested } = request;
    const fallbackId = request.target.ids[0] ?? label;
    if (unsupported) {
      outcomes.push({
        configId: fallbackId,
        requested,
        applied: false,
        detail: "The agent does not support session/set_config_option.",
      });
      continue;
    }

    const resolution = resolveConfigRequest(state, request.target, requested);
    switch (resolution.kind) {
      case "no_option": {
        const detail = `Kimi advertised no ${label} option, so the requested ${label} "${requested}" was ignored and the task ran at the agent's own default.`;
        warnings.push(detail);
        outcomes.push({ configId: fallbackId, requested, applied: false, detail });
        break;
      }
      case "ambiguous": {
        // Picking one would be a guess about which knob the user meant, and the
        // spec is explicit that categories carry no correctness guarantee.
        const detail = `Kimi advertised more than one ${label} option (${resolution.configIds.join(", ")}), so the requested ${label} "${requested}" was ignored rather than guessed at.`;
        warnings.push(detail);
        outcomes.push({ configId: fallbackId, requested, applied: false, detail });
        break;
      }
      case "not_offered": {
        const offered =
          resolution.offered.length === 0 ? "no values" : resolution.offered.join(", ");
        const detail = `Kimi does not offer ${label} "${requested}". It offers ${offered}, and stays at "${resolution.currentValue}".`;
        warnings.push(detail);
        outcomes.push({ configId: resolution.configId, requested, applied: false, detail });
        break;
      }
      case "already": {
        // The agent already reports this value, and it has no idempotency check,
        // so setting it again costs a round-trip and a spurious notification.
        sent.set(resolution.configId, resolution.value);
        outcomes.push({ configId: resolution.configId, requested, applied: true });
        break;
      }
      case "apply": {
        try {
          const response = await setOption(resolution.configId, resolution.value);
          const next = parseConfigOptions(response);
          // The response must carry the complete state. An empty one would mean
          // the agent contradicted itself, so the known state is kept instead of
          // reporting a session with no options at all.
          if (next.length > 0) state = next;
          sent.set(resolution.configId, resolution.value);
          outcomes.push({ configId: resolution.configId, requested, applied: true });
        } catch (error) {
          const detail =
            errorCode(error) === METHOD_NOT_FOUND
              ? `This Kimi build does not support session/set_config_option, so the requested ${label} "${requested}" was ignored.`
              : `Kimi refused to set ${label} to "${requested}": ${errorDetail(error)}`;
          // A missing method is missing for every request, so stop asking.
          if (errorCode(error) === METHOD_NOT_FOUND) unsupported = true;
          warnings.push(detail);
          outcomes.push({ configId: resolution.configId, requested, applied: false, detail });
        }
        break;
      }
    }
  }

  // Only now can a value applied earlier be checked against the final state: a
  // later set can remap it, and the agent may accept a value but report a
  // different effective one.
  for (const [configId, value] of sent) {
    const option = state.find((candidate) => candidate.id === configId);
    if (option === undefined) {
      warnings.push(
        `Kimi no longer offers the "${configId}" option after the other settings were applied, so "${value}" is not in effect.`,
      );
    } else if (option.currentValue !== value) {
      warnings.push(
        `Kimi reports ${option.label}="${option.currentValue}" after the other settings were applied, not the requested "${value}".`,
      );
    }
  }

  return {
    state,
    outcomes: outcomes.map((outcome) => {
      const option = state.find((candidate) => candidate.id === outcome.configId);
      return option === undefined ? outcome : { ...outcome, effectiveValue: option.currentValue };
    }),
    warnings,
  };
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
