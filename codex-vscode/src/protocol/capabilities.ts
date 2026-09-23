import type { ExperimentalFeatureListResponse } from '../generated/v2/ExperimentalFeatureListResponse';
import type { ModelListResponse } from '../generated/v2/ModelListResponse';
import type { MultiAgentVersion } from '../generated/v2/MultiAgentVersion';

/** Canonical feature key, matching `codex-rs/features/src/lib.rs`. */
const FEATURE_MULTI_AGENT_V2 = 'multi_agent_v2';

/** Issues a JSON-RPC request against the app-server. */
export type Request = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

export interface MultiAgentCapability {
  /** Whether the engine will run multi-agent v2 for this session. */
  active: boolean;
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
 * Confirms the engine is running multi-agent v2 and reports what that bought.
 *
 * The panel only speaks v2: its orchestration view is driven by `subAgentActivity` and
 * the thread broadcasts, none of which v1 emits. v2 is requested when the app-server is
 * spawned (see `REQUIRED_FEATURES`), because it is not one of the features the engine
 * lets a client toggle at runtime. This checks the request actually took, since an older
 * codex would simply not know the feature.
 */
export async function checkMultiAgentV2(
  request: Request,
  selectedModel: string,
): Promise<MultiAgentCapability> {
  const [features, modelDeclaredVersion] = await Promise.all([
    listFeatures(request),
    declaredVersionForModel(request, selectedModel),
  ]);
  const active = features.get(FEATURE_MULTI_AGENT_V2) ?? false;
  return {
    active,
    modelDeclaredVersion,
    nestedSpawnSupported: active && modelDeclaredVersion === 'v2',
  };
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
