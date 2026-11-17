import fs from 'fs';
import path from 'path';
import { KuzuStore, Schema, SelfGraph, toJsonable } from '@hydradb/selfgraph';
import config from '../config.js';

/**
 * Companion Personal & Household Knowledge Graph Ontology for SelfGraph.
 * Uses `contradiction: "supersede"` with `max_count: 1` on single-valued personal facts
 * (employer, primary residence, primary contact) while keeping `schema_mode: "warn"`
 * so open/ad-hoc personal entity and relation types remain accepted.
 */
export const COMPANION_SELFGRAPH_SCHEMA = Schema.parse({
  entities: [
    { name: 'Person', aliases: ['Contact', 'FamilyMember', 'Contractor'] },
    { name: 'Organization', aliases: ['Company', 'Employer', 'School'] },
    { name: 'Vendor', parent: 'Organization', aliases: ['ServiceProvider', 'Merchant'] },
    { name: 'Project', aliases: ['Repo', 'Initiative'] },
    { name: 'Place', aliases: ['Location', 'City', 'Address'] },
    { name: 'Topic', aliases: ['Interest', 'Skill', 'Category'] }
  ],
  relations: [
    {
      type: 'WORKS_AT',
      aliases: ['EMPLOYED_BY'],
      from: { types: ['Person'], max_count: 1 },
      to: { types: ['Organization'] }
    },
    {
      type: 'LIVES_IN',
      aliases: ['RESIDES_IN'],
      from: { types: ['Person'], max_count: 1 },
      to: { types: ['Place'] }
    },
    {
      type: 'PRIMARY_VENDOR_FOR',
      from: { types: ['Topic'], max_count: 1 },
      to: { types: ['Organization', 'Person'] }
    },
    {
      type: 'OWNS',
      from: { types: ['Person', 'Organization'] },
      to: { types: ['Project', 'Place', 'Topic'] }
    },
    {
      type: 'KNOWS',
      from: { types: ['Person'] },
      to: { types: ['Person'] }
    }
  ]
});

let cachedGraph = null;
let cachedKuzuPath = null;
let cachedNamespace = null;

/**
 * Resolve the embedded Kuzu database path next to the active `companion.db`.
 *
 * @returns {string}
 */
export function resolveCompanionSelfGraphPath() {
  if (process.env.SELFGRAPH_KUZU_PATH && process.env.SELFGRAPH_KUZU_PATH.trim()) {
    return path.resolve(process.env.SELFGRAPH_KUZU_PATH.trim());
  }
  const activeSqlitePath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : config.dbPath();
  const dataDir = path.dirname(activeSqlitePath);
  fs.mkdirSync(dataDir, { recursive: true });
  const baseName = path.basename(activeSqlitePath, path.extname(activeSqlitePath)) || 'companion';
  return path.join(dataDir, `${baseName}-selfgraph.kuzu`);
}

/**
 * Get or initialize the singleton embedded `SelfGraph` (`KuzuStore`) instance
 * scoped to the active Companion data directory and namespace.
 *
 * @param {object} [options]
 * @param {string} [options.namespace]
 * @param {string} [options.kuzuPath]
 * @returns {Promise<{ graph: SelfGraph, kuzuPath: string, namespace: string }>}
 */
export async function getCompanionSelfGraph(options = {}) {
  const targetPath = options.kuzuPath
    ? path.resolve(options.kuzuPath)
    : resolveCompanionSelfGraphPath();
  const targetNs = String(options.namespace || process.env.SELFGRAPH_NAMESPACE || 'companion').trim() || 'companion';

  if (cachedGraph && cachedKuzuPath === targetPath && cachedNamespace === targetNs) {
    return { graph: cachedGraph, kuzuPath: cachedKuzuPath, namespace: cachedNamespace };
  }

  if (cachedGraph) {
    await closeCompanionSelfGraph();
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const store = new KuzuStore(targetPath);
  const graph = new SelfGraph(store, {
    namespace: targetNs,
    schema: COMPANION_SELFGRAPH_SCHEMA,
    schema_mode: 'warn',
    contradiction: 'supersede',
    resolver: 'default'
  });
  await graph.initialize();

  cachedGraph = graph;
  cachedKuzuPath = targetPath;
  cachedNamespace = targetNs;
  return { graph, kuzuPath: targetPath, namespace: targetNs };
}

/**
 * Close the active Companion `SelfGraph` and release the underlying Kuzu database handle.
 */
export async function closeCompanionSelfGraph() {
  const prevGraph = cachedGraph;
  const prevPath = cachedKuzuPath;
  cachedGraph = null;
  cachedKuzuPath = null;
  cachedNamespace = null;

  if (prevGraph) {
    try {
      await prevGraph.close();
    } catch {
      // Ignore close race during teardown
    }
  }
  if (prevPath) {
    try {
      await KuzuStore.closeDatabase(prevPath);
    } catch {
      // Ignore if already closed
    }
  }
}

/**
 * Execute an operation against the Companion SelfGraph knowledge graph.
 *
 * @param {object} args
 * @param {object} [options]
 */
export async function executeCompanionSelfGraph(args = {}, options = {}) {
  const action = String(args.action || 'retrieve').trim().toLowerCase();
  const { graph, kuzuPath, namespace } = await getCompanionSelfGraph({
    namespace: options.namespace || args.namespace,
    kuzuPath: options.kuzuPath
  });

  if (action === 'status') {
    const [entitiesPage, relationsPage, decisionsPage] = await Promise.all([
      graph.entities.list({ limit: 1000 }),
      graph.relations.list({ limit: 1000 }),
      graph.decisions.list({ limit: 1000 })
    ]);
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `SelfGraph (KuzuStore @ ${path.basename(kuzuPath)}, ns=${namespace}): ${entitiesPage.items.length} entities, ${relationsPage.items.length} active relations, ${decisionsPage.items.length} decisions.`,
      data: {
        backend: 'kuzu',
        kuzuPath,
        namespace,
        entityCount: entitiesPage.items.length,
        relationCount: relationsPage.items.length,
        decisionCount: decisionsPage.items.length
      }
    };
  }

  if (action === 'upsert_facts') {
    const facts = args.facts && typeof args.facts === 'object'
      ? args.facts
      : {
          entities: Array.isArray(args.entities) ? args.entities : [],
          relations: Array.isArray(args.relations) ? args.relations : [],
          preferences: Array.isArray(args.preferences) ? args.preferences : [],
          decisions: Array.isArray(args.decisions) ? args.decisions : []
        };
    const insertOpts = {};
    if (args.sourceId) insertOpts.source_id = String(args.sourceId);
    if (args.eventTime) insertOpts.event_time = String(args.eventTime);
    if (args.resolver) insertOpts.resolver = String(args.resolver);

    const res = toJsonable(await graph.insert.facts(facts, insertOpts));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `Stored ${res.entities.length} entities, ${res.relations.length} relations, ${res.preferences.length} preferences, and ${res.decisions.length} decisions in SelfGraph (${res.warnings.length} warnings).`,
      data: res
    };
  }

  if (action === 'ingest_note') {
    const text = String(args.text || args.content || '').trim();
    if (!text) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'ingest_note requires a non-empty text string.'
      };
    }
    const insertOpts = {};
    if (args.sourceId) insertOpts.source_id = String(args.sourceId);
    if (args.replaceSource !== undefined) insertOpts.replace_source = Boolean(args.replaceSource);
    if (args.eventTime) insertOpts.event_time = String(args.eventTime);

    const res = toJsonable(await graph.insert.text(text, insertOpts));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `Ingested note into SelfGraph (${res.entities.length} entities, ${res.relations.length} relations, source_version=${res.source_version || 'n/a'}).`,
      data: res
    };
  }

  if (action === 'retrieve' || action === 'query') {
    const query = String(args.query || args.prompt || '').trim();
    if (!query) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'retrieve requires a non-empty query string.'
      };
    }
    const retrieveOpts = {
      strategy: args.strategy || 'ppr',
      budget_tokens: Number(args.budgetTokens || 600),
      depth: Number(args.depth || 2)
    };
    if (args.asOf) retrieveOpts.as_of = String(args.asOf);
    if (args.knownAt) retrieveOpts.known_at = String(args.knownAt);

    const res = toJsonable(await graph.retrieve(query, retrieveOpts));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: res.context
        ? `### SelfGraph Context (${res.subgraph.entities.length} entities, ${res.subgraph.relations.length} relations)\n${res.context}`
        : `No matching entities found in SelfGraph for "${query}".`,
      data: res
    };
  }

  if (action === 'check_answerable') {
    const query = String(args.query || args.prompt || '').trim();
    if (!query) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'check_answerable requires a non-empty query string.'
      };
    }
    const opts = {};
    if (Array.isArray(args.terms) && args.terms.length > 0) opts.terms = args.terms.map(String);
    if (args.asOf) opts.as_of = String(args.asOf);

    const report = toJsonable(await graph.checkAnswerable(query, opts));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `SelfGraph answerability for "${query}": ${report.verdict} (missing: ${report.missing.length ? report.missing.join(', ') : 'none'}).`,
      data: report
    };
  }

  if (action === 'diff') {
    if (!args.since) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'diff requires an ISO 8601 `since` timestamp.'
      };
    }
    const diffRes = toJsonable(await graph.diff(String(args.since), args.until ? String(args.until) : null));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `SelfGraph diff since ${args.since}: +${diffRes.relations_added.length} added relations, -${diffRes.relations_retired.length} retired relations, +${diffRes.entities_created.length} created entities.`,
      data: diffRes
    };
  }

  if (action === 'certify_relation') {
    const relationId = String(args.relationId || '').trim();
    if (!relationId) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'certify_relation requires a `relationId`.'
      };
    }
    const by = args.certifiedBy === null ? null : String(args.certifiedBy || config.app?.ownerName || 'owner');
    const rel = toJsonable(
      by === null
        ? await graph.relations.uncertify(relationId)
        : await graph.relations.certify(relationId, { by })
    );
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: by
        ? `Certified relation ${rel.id} (rev ${rel.revision}) by ${by}.`
        : `Cleared certification on relation ${rel.id}.`,
      data: rel
    };
  }

  if (action === 'merge_entities') {
    const survivorId = String(args.survivorId || '').trim();
    const duplicateIds = Array.isArray(args.duplicateIds)
      ? args.duplicateIds.map(String).filter(Boolean)
      : args.duplicateId
        ? [String(args.duplicateId)]
        : [];
    if (!survivorId || duplicateIds.length === 0) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'merge_entities requires `survivorId` and `duplicateIds`.'
      };
    }
    const merges = [];
    for (const dupId of duplicateIds) {
      const existing = await graph.entities.get(dupId);
      if (!existing) continue;
      const [outgoing, incoming] = await Promise.all([
        graph.relations.list({ from_entity: dupId, limit: 500 }),
        graph.relations.list({ to_entity: dupId, limit: 500 })
      ]);
      await graph.entities.delete(dupId);
      const rewiredRelations = [
        ...outgoing.items.map((r) => ({
          from_entity: dupId,
          type: r.type,
          to_entity: r.to_entity,
          properties: r.properties || {},
          ...(r.event_time ? { event_time: r.event_time } : {})
        })),
        ...incoming.items
          .filter((r) => r.from_entity !== dupId)
          .map((r) => ({
            from_entity: r.from_entity,
            type: r.type,
            to_entity: dupId,
            properties: r.properties || {},
            ...(r.event_time ? { event_time: r.event_time } : {})
          }))
      ];
      const inserted = await graph.insert.facts(
        {
          entities: [
            {
              type: existing.type,
              name: existing.name,
              aliases: existing.aliases || [],
              external_ids: existing.external_ids || {},
              properties: existing.properties || {}
            }
          ],
          relations: rewiredRelations
        },
        {
          resolver: {
            resolve: async () => ({
              target_id: survivorId,
              confidence: 1,
              reason: 'explicit_merge'
            })
          }
        }
      );
      merges.push(...toJsonable(inserted.merges));
    }
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `Merged [${duplicateIds.join(', ')}] into ${survivorId} (${merges.length} merge record(s)).`,
      data: { merges }
    };
  }

  if (action === 'unmerge') {
    const mergeId = String(args.mergeId || '').trim();
    if (!mergeId) {
      return {
        ok: false,
        tool: 'selfgraph_knowledge',
        summary: 'unmerge requires a `mergeId`.'
      };
    }
    const restored = toJsonable(await graph.entities.unmerge(mergeId));
    return {
      ok: true,
      tool: 'selfgraph_knowledge',
      actionType: 'knowledge_graph',
      summary: `Unmerged ${mergeId}: restored ${restored.entity.id} from ${restored.survivor?.id || 'survivor'}.`,
      data: restored
    };
  }

  return {
    ok: false,
    tool: 'selfgraph_knowledge',
    summary: `Unsupported selfgraph_knowledge action "${action}". Supported: status, upsert_facts, ingest_note, retrieve, check_answerable, diff, certify_relation, merge_entities, unmerge.`
  };
}

export const SELFGRAPH_EXTENSION_TOOL = {
  extensionId: 'selfgraph-knowledge-graph',
  displayName: 'SelfGraph Bi-Temporal Personal Knowledge Graph (Embedded Kuzu)',
  name: 'selfgraph_knowledge',
  category: 'knowledge_graph',
  description:
    'Opt-in SelfGraph Bi-Temporal Personal Knowledge Graph (embedded KuzuStore): store versioned entities, superseding relations, preferences, and decisions, run PPR/asOf time-travel retrieval, certify facts, and merge/unmerge duplicates at $0 LLM cost.',
  parameters: {
    action:
      'string (REQUIRED: "retrieve" | "upsert_facts" | "ingest_note" | "check_answerable" | "diff" | "certify_relation" | "merge_entities" | "unmerge" | "status")',
    query: 'string (Natural-language query for retrieve or check_answerable)',
    facts: 'object ({ entities?, relations?, preferences?, decisions? } for upsert_facts)',
    text: 'string (Unstructured note text for zero-LLM ingest_note)',
    sourceId: 'string (Optional provenance source ID)',
    replaceSource: 'boolean (Withdraw prior facts from sourceId when re-ingesting)',
    eventTime: 'string (Optional ISO 8601 valid time)',
    asOf: 'string (Optional ISO 8601 point-in-time valid date for time-travel retrieve)',
    knownAt: 'string (Optional ISO 8601 transaction date for known-at replay)',
    since: 'string (ISO 8601 start timestamp for diff)',
    until: 'string (Optional ISO 8601 end timestamp for diff)',
    relationId: 'string (Target relation ID for certify_relation)',
    certifiedBy: 'string | null (Verifier name or null to uncertify)',
    survivorId: 'string (Target canonical entity ID for merge_entities)',
    duplicateIds: 'array of strings (Duplicate entity IDs to fold into survivorId)',
    mergeId: 'string (Merge record ID to reverse via unmerge)',
    budgetTokens: 'number (Token cap for retrieve context, default: 600)'
  },
  required: ['action'],
  execute: executeCompanionSelfGraph
};
