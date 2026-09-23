import type { ExperimentalFeatureListResponse } from '../generated/v2/ExperimentalFeatureListResponse';
import type { ModelListResponse } from '../generated/v2/ModelListResponse';
import type { MultiAgentVersion } from '../generated/v2/MultiAgentVersion';

/** Canonical feature keys, matching `codex-rs/features/src/lib.rs`. */
const FEATURE_MULTI_AGENT_V2 = 'multi_agent_v2';
const FEATURE_COLLAB = 'multi_agent';

/** Issues a JSON-RPC request against the app-server. */
export type Request = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

export interface MultiAgentCapability {
  /** Version the engine will actually use for new turns. */
  version: MultiAgentVersion;
  featureV2Enabled: boolean;
  collabEnabled: boolean;
  /** Version declared by the selected model, when the catalog reports one. */
  modelDeclaredVersion: MultiAgentVersion | null;
  /**
   * Whether a sub-agent can spawn sub-agents of its own.
   *
   * Under v2 the root agent always gets the collaboration tools, but a non-root agent only
   * gets them when the model itself declares v2 (`collab_tools_enabled` in
   * `core/src/tools/spec_plan.rs`). Forcing v2 through the feature flag therefore buys a
   * single level of delegation, not a tree.
   */
  nestedSpawnSupported: boolean;
}

/**
 * Resolves the multi-agent runtime the engine will use.
 *
 * This mirrors `Config::multi_agent_version_for_model`: an enabled `multi_agent_v2`
 * feature wins outright, otherwise the model's declared version applies, and the
 * `multi_agent` feature provides the v1 fallback.
 *
 * One divergence: the engine also forces `disabled` when `agents_enabled` is false in
 * config.toml, but that field is not exposed over the config RPC, so it is not
 * considered here. It defaults to enabled, so the resolved version only differs for
 * users who explicitly turned agents off.
 */
export async function detectMultiAgent(
  request: Request,
  selectedModel: string,
): Promise<MultiAgentCapability> {
  const [features, modelDeclaredVersion] = await Promise.all([
    listFeatures(request),
    declaredVersionForModel(request, selectedModel),
  ]);
  const featureV2Enabled = features.get(FEATURE_MULTI_AGENT_V2) ?? false;
  const collabEnabled = features.get(FEATURE_COLLAB) ?? false;

  let version: MultiAgentVersion;
  if (featureV2Enabled) {
    version = 'v2';
  } else if (modelDeclaredVersion) {
    version = modelDeclaredVersion;
  } else {
    version = collabEnabled ? 'v1' : 'disabled';
  }

  return {
    version,
    featureV2Enabled,
    collabEnabled,
    modelDeclaredVersion,
    nestedSpawnSupported: version === 'v2' && modelDeclaredVersion === 'v2',
  };
}

/**
 * Turns on multi-agent v2 for the running app-server process.
 *
 * This is runtime-only and does not touch config.toml, so it is lost on restart.
 */
export async function enableMultiAgentV2ForSession(request: Request): Promise<boolean> {
  try {
    const res = (await request('experimentalFeature/enablement/set', {
      enablement: { [FEATURE_MULTI_AGENT_V2]: true },
    })) as { enablement?: Record<string, boolean | undefined> };
    return res?.enablement?.[FEATURE_MULTI_AGENT_V2] === true;
  } catch {
    return false;
  }
}

async function listFeatures(request: Request): Promise<Map<string, boolean>> {
  const enabled = new Map<string, boolean>();
  let cursor: string | null = null;
  do {
    let page: ExperimentalFeatureListResponse;
    try {
      page = (await request('experimentalFeature/list', {
        cursor,
      })) as ExperimentalFeatureListResponse;
    } catch {
      return enabled;
    }
    for (const feature of page.data ?? []) {
      enabled.set(feature.name, feature.enabled);
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return enabled;
}

async function declaredVersionForModel(
  request: Request,
  selectedModel: string,
): Promise<MultiAgentVersion | null> {
  if (!selectedModel) {
    return null;
  }
  let page: ModelListResponse;
  try {
    page = (await request('model/list', { includeHidden: true })) as ModelListResponse;
  } catch {
    return null;
  }
  const match = (page.data ?? []).find(
    (model) => model.id === selectedModel || model.model === selectedModel,
  );
  return match?.multiAgentVersion ?? null;
}
