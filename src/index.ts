/**
 * dsh-continual-harness — a standalone DeepSeek Harness plugin implementing
 * continual harness self-evolution. One plugin mounts the
 * store, the model-facing `harness_refine` tool, the digest-tracked prompt
 * projection, and the automatic refinement gate.
 *
 * Mounting: add this package as a plugin of a dsh profile (e.g. through the
 * profile's cordis.patch.yml or the settings UI). It needs the `tools`,
 * `agents`, and `session` capability packages loaded before it.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS, DEFAULT_TOKEN_PER_CHAR_RATIO, MIN_PLANNER_OUTPUT_TOKENS,
} from './budget.ts'
import { DEFAULT_PLANNER_MAX_TOKENS } from './complete.ts'
import type { PlannerPrefixCacheMode } from './cache-detect.ts'
import { registerRefineCommand } from './command.ts'
import type { CommandsCapability } from './command.ts'
import { DEFAULT_COOLDOWN_MS, DEFAULT_TURN_INTERVAL } from './driver.ts'
import { DEFAULT_SKILL_BUNDLE_LIMITS } from './skills.ts'
import { HARNESS_REFINEMENT_EVENT, OWNED_REFINEMENT_KINDS, registerSessionEventType } from './domain.ts'
import { attachFileLog, PLUGIN_LOG_FILE_NAME } from './logfile.ts'
import { DEFAULT_TRAJECTORY_MAX_CHARS, DEFAULT_TRAJECTORY_SIGNAL_RATIO } from './store.ts'
import type { InjectionAnchor } from './render.ts'
import { workspacePathFor, type WorkspaceRegistryLike } from './project.ts'
import { registerHarnessProjection } from './projection.ts'
import { registerSessionProjectionObserver } from './session-state.ts'
import { installHostRequestSnapshot } from './request-snapshot.ts'
import { HarnessStore } from './store.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SkillOwner } from './skill-owner.ts'
import { createManualDreamCoordinator } from './dream-adapter.ts'
import { createRuntimeSkillOwner } from './skill-owner-runtime.ts'
import { defaultHarnessHome } from './storage.ts'
import { registerBenchmarkTool } from './tool-benchmark.ts'
import { registerHarnessTool, registerHarnessWrapup } from './tool.ts'
import type { RefinementKind } from './types.ts'

export const name = 'continual-harness'
export const inject = ['agents', 'tools']

/** Automatic refinement gate configuration. */
export interface AutoRefineConfig {
  /** Whether the gate runs at all. */
  enabled: boolean
  /** Assistant turns between automatic refinement passes. */
  turnInterval: number
  /** Cooldown between automatic refinement attempts. */
  cooldownMs: number
  /** Whether a compaction also triggers a gate pass. */
  compact: boolean
}

/** Explicit benchmark tool configuration (spec §5). */
export interface BenchmarkConfig {
  /** Whether the `harness_benchmark` tool is registered. */
  enabled: boolean
  /** Iterations per case per side when a run omits `runs`. */
  defaultRuns: number
  /** Upper bound for `runs`; a larger explicit value is refused. */
  maxRuns: number
  /** Report-only pass line in 0..100; never gates acceptance (§4.5). */
  passThreshold: number
  /** How far the candidate may fall below the reference before regressing. */
  regressionTolerance: number
  /** Maximum failed candidate cells a run may still accept. */
  maxFailedCells: number
}

/** Continual harness plugin configuration. */
export interface Config {
  /** Harness home; defaults under the dsh home directory. */
  harnessRoot?: string
  /**
   * Directory where skill entries materialize as dsh SKILL.md bundles.
   * Defaults to the dsh user skills root (`$DSH_HOME/skills`), which dsh's
   * filesystem skill provider scans live.
   */
  skillsDir?: string
  /**
   * Required deployment choice for the store the tool targets when a call
   * omits `global`: local keeps lessons session-scoped, global makes them
   * cross-session.
   */
  defaultGlobal: boolean
  /** Tail-biased trajectory window fed to the planner. */
  maxTrajectoryChars: number
  /** Output budget for the planning call. */
  plannerMaxTokens: number
  /** Planner prefix-cache routing: auto-detect, force session prefix, or off. */
  plannerPrefixCache?: PlannerPrefixCacheMode
  /**
   * Legacy compatibility key retained for schema compatibility only. Route A
   * no longer truncates or caps the session prefix — it reuses the host-loop
   * request snapshot verbatim (spec §2.2), so this value bounds nothing and is
   * not forwarded to the coordinator. Kept so existing configs keep validating.
   */
  plannerPrefixMaxChars?: number
  /** Route B: fraction of the trajectory budget reserved for the verbatim signal layer. */
  trajectorySignalRatio?: number
  /** Shared char→token estimate ratio for planner budget control (A and B). */
  plannerTokenPerCharRatio?: number
  /** Tokens reserved inside the context window for safety. */
  plannerSafetyReserveTokens?: number
  /** Minimum output tokens a planner route must be able to produce. */
  minPlannerOutputTokens?: number
  /** Automatic refinement gate settings. */
  autoRefine?: AutoRefineConfig
  /** Require explicit human approval before a global refinement commits. */
  requireGlobalApproval: boolean
  /** Per-kind cap for ranked injection into the model-visible overview. */
  maxInjectedEntriesPerKind: number
  /** What the injected block is ranked against: the live question or a session-stable anchor. */
  injectionAnchor: InjectionAnchor
  /** Register the harness_wrapup tool. */
  wrapupEnabled: boolean
  /** Audit automatic review verdicts into the session log. */
  auditReviews: boolean
  /** Explicit benchmark tool settings (spec §5). */
  benchmark?: BenchmarkConfig
  /** Persist harness logs to a file. */
  logToFile: boolean
  /** Cap on the harness log file size in bytes. */
  logMaxBytes: number
  /** Per-commit entry growth fraction cap; 0 disables the check. */
  maxEntryGrowth: number
  /** Kinds the automatic path may not modify. */
  protectedKinds: RefinementKind[]
  /** Skill bundle limits (spec §7.10): file count, per-file bytes, total bytes (UTF-8). */
  maxSkillFiles: number
  maxSkillFileBytes: number
  maxSkillBundleBytes: number
  /** Run post-apply diagnostics after each committed refinement. */
  diagnosticsEnabled: boolean
  /** Enable the local L3 security provider inside the diagnostics runner. */
  securityEnabled: boolean
}

/** Benchmark configuration (spec §5) with its MVP defaults. */
export interface BenchmarkConfig {
  /** Whether the benchmark tool is registered at all. */
  enabled: boolean
  /** Iterations when the tool call omits `runs`. */
  defaultRuns: number
  /** Hard cap on iterations per run. */
  maxRuns: number
  /** Validated and threaded through, but currently neither gates the verdict
   *  nor appears in the run output (spec §4.5 intended it as a report line). */
  passThreshold: number
  /** Allowed downward drift of candidate vs reference before regression. */
  regressionTolerance: number
  /**
   * Accepted for backward compatibility only: under the paired comparison a
   * failed cell drops its own pair (`pairs` reports the real sample size), so
   * this no longer changes the verdict.
   */
  maxFailedCells: number
}

/** Benchmark config defaults (spec §5); shared by the schema and the apply fallback. */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  enabled: true,
  defaultRuns: 3,
  // The verdict bar is a 95% t-interval of the paired differences, so it only
  // narrows as pairs accumulate: at the measured σ≈10 a 5-point effect needs
  // ≈19 pairs, which is ≈24 runs once a 20% cell-failure rate is counted. A cap
  // of 3 makes a decision arithmetically impossible, so the cap leaves room to
  // reach that power while the default stays cheap.
  maxRuns: 30,
  passThreshold: 60,
  regressionTolerance: 0,
  maxFailedCells: 0,
}

/** Schemastery configuration for the continual harness plugin. */
export const Config: z<Config> = z.object({
  harnessRoot: z.string(),
  skillsDir: z.string(),
  // Defaulted rather than required: an id-targeted profile override *replaces*
  // the whole config, so a required key deactivates the plugin for anyone who
  // overrides one unrelated key (`invalid config: $.defaultGlobal missing
  // required value`, reported only as `1 entry did not activate`).
  defaultGlobal: z.boolean().default(true),
  maxTrajectoryChars: z.number().step(1).min(1).default(DEFAULT_TRAJECTORY_MAX_CHARS),
  plannerMaxTokens: z.number().step(1).min(1).default(DEFAULT_PLANNER_MAX_TOKENS),
  // schemastery v3 has no `enum`; the union-of-literals idiom matches
  // `protectedKinds` below and validates identically.
  plannerPrefixCache: z.union(['auto', 'session', 'off']).default('auto'),
  // object fields are optional unless `.required()` (schemastery v3 has no
  // `.optional()` combinator); accepted for schema compatibility only — Route A
  // reuses the host prefix verbatim and never truncates it.
  plannerPrefixMaxChars: z.number().step(1).min(1),
  trajectorySignalRatio: z.number().min(0).max(1).default(DEFAULT_TRAJECTORY_SIGNAL_RATIO),
  plannerTokenPerCharRatio: z.number().min(0).max(1).default(DEFAULT_TOKEN_PER_CHAR_RATIO),
  plannerSafetyReserveTokens: z.number().step(1).min(0).default(DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS),
  minPlannerOutputTokens: z.number().step(1).min(1).default(MIN_PLANNER_OUTPUT_TOKENS),
  autoRefine: z.object({
    enabled: z.boolean().default(true),
    turnInterval: z.number().step(1).min(1).default(DEFAULT_TURN_INTERVAL),
    cooldownMs: z.number().step(1).min(1).default(DEFAULT_COOLDOWN_MS),
    compact: z.boolean().default(true),
  }).default({ enabled: true, turnInterval: DEFAULT_TURN_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS, compact: true }),
  requireGlobalApproval: z.boolean().default(false),
  maxInjectedEntriesPerKind: z.number().step(1).min(1).default(6),
  // Stable by default: a live-question anchor re-publishes the block whenever
  // the topic moves, and every re-publication invalidates the provider's cached
  // prefix. Measured over one six-message session (same corpus, same model, the
  // anchor the only difference): 95.4% vs 81.2% cache-read hit rate, 23.3k vs
  // 358k uncached input tokens, 0 vs 5 full prefix re-reads. State changes still
  // re-publish under `stable` (the gate keys on the refinement stamp, not the
  // anchor), so this trades per-turn topical selection for a surviving prefix.
  injectionAnchor: z.union(['query', 'stable']).default('stable'),
  wrapupEnabled: z.boolean().default(true),
  auditReviews: z.boolean().default(true),
  benchmark: z.object({
    enabled: z.boolean().default(DEFAULT_BENCHMARK_CONFIG.enabled),
    defaultRuns: z.number().step(1).min(1).default(DEFAULT_BENCHMARK_CONFIG.defaultRuns),
    maxRuns: z.number().step(1).min(1).default(DEFAULT_BENCHMARK_CONFIG.maxRuns),
    passThreshold: z.number().min(0).max(100).default(DEFAULT_BENCHMARK_CONFIG.passThreshold),
    regressionTolerance: z.number().min(0).default(DEFAULT_BENCHMARK_CONFIG.regressionTolerance),
    maxFailedCells: z.number().step(1).min(0).default(DEFAULT_BENCHMARK_CONFIG.maxFailedCells),
  }).default(DEFAULT_BENCHMARK_CONFIG),
  logToFile: z.boolean().default(true),
  logMaxBytes: z.number().step(1).min(1).default(5 * 1024 * 1024),
  maxEntryGrowth: z.number().min(0).default(0.5),
  protectedKinds: z.array(z.union(['prompt', 'memory', 'skill', 'subagent'])).default(['skill']),
  maxSkillFiles: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillFiles),
  maxSkillFileBytes: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillFileBytes),
  maxSkillBundleBytes: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillBundleBytes),
  diagnosticsEnabled: z.boolean().default(true),
  securityEnabled: z.boolean().default(false),
})

/**
 * Mount the continual harness: store, tool, projection, and driver. All
 * contributions register through effect-based APIs and dispose with the
 * context.
 * @param ctx - Cordis context carrying the tools and agents services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Legacy compatibility: older plugin builds wrote the `harness/refinement`
  // session event without an `ignorable` envelope marker; register the type
  // so those historical logs stay readable (removable once they age out).
  registerSessionEventType(HARNESS_REFINEMENT_EVENT)

  // DSH accounts sessions to Workspaces by canonical cwd, and a Workspace is the
  // user's own project unit — a better tag than anything a walk-up can infer. The
  // service is optional: a deployment without Workspaces simply leaves project
  // tagging to the repository walk-up.
  const workspaces = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined

  // Cross-domain candidates travel to Evolution over the same loopback component
  // channel everything else uses. A deployment without an absolute DSH_HOME has
  // no such channel, so the harness simply keeps its own edits to itself rather
  // than pointing at a directory that cannot exist.
  const dshHome = process.env.DSH_HOME
  const candidateHome = dshHome !== undefined && isAbsolute(dshHome) ? dshHome : undefined
  const skillOwner = candidateHome
    ? createRuntimeSkillOwner(ctx, candidateHome, config.skillsDir ?? dshHomePath('skills'))
    : new SkillOwner(join(config.harnessRoot ?? defaultHarnessHome(), 'skill-owner'), async () => false, { skillsDir: config.skillsDir ?? dshHomePath('skills') })

  const store = new HarnessStore(ctx, {
    skillOwner,
    ...(config.harnessRoot === undefined ? {} : { harnessRoot: config.harnessRoot }),
    ...(config.skillsDir === undefined ? {} : { skillsDir: config.skillsDir }),
    maxEntryGrowth: config.maxEntryGrowth,
    protectedKinds: config.protectedKinds,
    // Memory, prompts, and subagent specs belong to ActMem, the Laputa/Superagent
    // prompt layer, and the Agent registry: this plugin may delete legacy entries
    // of those kinds but never create or update them.
    ownedKinds: [...OWNED_REFINEMENT_KINDS],
    skillBundleLimits: {
      maxSkillFiles: config.maxSkillFiles,
      maxSkillFileBytes: config.maxSkillFileBytes,
      maxSkillBundleBytes: config.maxSkillBundleBytes,
    },
    maxInjectedEntriesPerKind: config.maxInjectedEntriesPerKind,
    injectionAnchor: config.injectionAnchor,
    ...(workspaces === undefined ? {} : { workspacePathFor: (sessionId: string) => workspacePathFor(workspaces, sessionId) }),
  })
  skillOwner.migrateLegacy(Object.values(store.globalState().entries.skill))
  // One protocol-independent coordinator owns request validation, planner
  // context capture, approval gating, commit serialization, and result
  // projection for both the tool and the automatic driver. The same
  // coordinator carries the post-apply diagnostics runner, so tool, command,
  // and automatic gate all see one report per commit.
  installHostRequestSnapshot(ctx)
  // Production refinement always enters ordinary Superagent Input/Ticket control.
  // The legacy planning library remains available to tests and embedders only.
  const coordinator = createManualDreamCoordinator(candidateHome)
  registerHarnessTool(ctx, coordinator, {
    defaultGlobal: config.defaultGlobal,
  })
  // The /refine command adapter is an optional host capability: it registers
  // only when the Cordis context provides a `commands` service, and the
  // registration disposes with the plugin context. A missing capability logs
  // exactly one warning and never prevents the rest of the plugin from loading.
  // The adapter's default reporter delivers the settled outcome as a
  // plugin-source session message plus a harness log line.
  const commands = ctx.get('commands') as CommandsCapability | undefined
  if (commands) {
    // `commands.register()` returns the effect disposer itself, so handing it
    // straight back unregisters the command when the plugin context disposes.
    ctx.effect(() => registerRefineCommand(commands, coordinator, { defaultGlobal: config.defaultGlobal }))
  } else {
    ctx.logger('harness').warn('commands capability not available; the /refine command is not registered')
  }
  if (config.wrapupEnabled) {
    registerHarnessWrapup(ctx, store)
  }
  const benchmark = config.benchmark ?? DEFAULT_BENCHMARK_CONFIG
  if (benchmark.enabled) {
    registerBenchmarkTool(ctx, store, {
      defaultRuns: benchmark.defaultRuns,
      maxRuns: benchmark.maxRuns,
      passThreshold: benchmark.passThreshold,
      regressionTolerance: benchmark.regressionTolerance,
      maxFailedCells: benchmark.maxFailedCells,
    })
  }
  // Observation is registered before the projection, so the facts it reads
  // (the block sequence, cache-read evidence) are already being tracked
  // wherever the plugin runs.
  registerSessionProjectionObserver(ctx, store)
  registerHarnessProjection(ctx, store)
  if (config.logToFile) {
    attachFileLog(ctx, {
      file: join(store.home, PLUGIN_LOG_FILE_NAME),
      maxBytes: config.logMaxBytes,
    })
  }
}
