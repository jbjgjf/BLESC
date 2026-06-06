"use client";

import dynamic from "next/dynamic";
import type { ComponentType, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphSnapshot, ExplanationPayload } from "@/api/models";
import { ArrowLeftRight, Box, Cpu, Info, Orbit, RotateCw } from "lucide-react";
import type { ForceGraphMethods } from "react-force-graph-3d";
import type { GraphMode, GraphViewerLink, GraphViewerNode } from "./graphTypes";
import {
  buildGraphViewerData,
  buildConceptGraphData,
  buildNodeSelection,
  getDebugFallbackData,
  CATEGORY_COLORS,
} from "./graphAdapter";

type ForceGraphBoundaryProps = Record<string, unknown> & {
  ref?: MutableRefObject<ForceGraphMethods | null>;
};

const ForceGraph3D = dynamic(
  () => import("react-force-graph-3d"),
  { ssr: false },
) as unknown as ComponentType<ForceGraphBoundaryProps>;

const ENABLE_GRAPH_DEBUG = process.env.NEXT_PUBLIC_ENABLE_GRAPH_DEBUG === "true";

const CATEGORY_LEGEND = [
  { label: "State", color: CATEGORY_COLORS.State },
  { label: "Trigger", color: CATEGORY_COLORS.Trigger },
  { label: "Behavior", color: CATEGORY_COLORS.Behavior },
  { label: "Event", color: CATEGORY_COLORS.Event },
  { label: "Protective", color: CATEGORY_COLORS.Protective },
];

interface GraphViewer3DProps {
  snapshots: GraphSnapshot[];
  currentSnapshot?: GraphSnapshot | null;
  explanation?: ExplanationPayload | null;
  title?: string;
}

// ── Three.js helpers ───────────────────────────────────────────
function makeNodeObject(node: GraphViewerNode, isConceptMode: boolean) {
  const group = new THREE.Group();
  const color = new THREE.Color(node.color);

  // Outer bloom halo — large transparent shell that feeds the bloom pass
  const haloOuter = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 2.0, 8, 6),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.04,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  // Mid halo
  const haloMid = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 1.45, 12, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  // Emissive core — drives the bloom glow
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 0.72, 24, 18),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: node.sourceKind === "historical" ? 0.45 : 0.88,
      roughness: 0.12,
      metalness: 0.0,
    }),
  );

  // Bright white centre — creates the specular highlight seen in Obsidian nodes
  const centre = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 0.32, 10, 7),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: node.sourceKind === "historical" ? 0.25 : 0.55,
      blending: THREE.AdditiveBlending,
    }),
  );

  group.add(haloOuter);
  group.add(haloMid);
  group.add(core);
  group.add(centre);

  // Label — shown for concept hubs or large nodes only, to avoid clutter
  const showLabel = isConceptMode ? (node.frequency ?? 0) >= 2 || node.radius > 8 : node.radius > 6;
  if (showLabel) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 72;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = "bold 26px 'Arial'";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Glow text for dark background
      ctx.shadowColor = node.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      const raw = node.label;
      const label = raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
      ctx.fillText(label, 256, 36);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.position.set(0, node.radius + 7, 0);
    sprite.scale.set(38, 8, 1);
    group.add(sprite);
  }

  return group;
}

// ── Component ──────────────────────────────────────────────────
export function GraphViewer3D({
  snapshots,
  currentSnapshot,
  explanation,
  title = "Local graph viewer",
}: GraphViewer3DProps) {
  const [mode, setMode] = useState<GraphMode>("current");
  const [selectedNode, setSelectedNode] = useState<GraphViewerNode | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [graphWidth, setGraphWidth] = useState(900);
  const fgRef = useRef<ForceGraphMethods | null>(null);
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const bloomSetupRef = useRef(false);

  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => `${a.day}`.localeCompare(`${b.day}`)),
    [snapshots],
  );
  const activeSnapshot = currentSnapshot ?? orderedSnapshots.at(-1) ?? null;

  // Responsive width
  useEffect(() => {
    const frame = graphFrameRef.current;
    if (!frame) return;
    const update = () => setGraphWidth(Math.max(320, Math.floor(frame.getBoundingClientRect().width)));
    update();
    const obs = new ResizeObserver(update);
    obs.observe(frame);
    return () => obs.disconnect();
  }, []);

  // Graph data
  const realGraphData = useMemo(
    () => mode === "concept"
      ? buildConceptGraphData(orderedSnapshots)
      : buildGraphViewerData(orderedSnapshots, mode, activeSnapshot),
    [orderedSnapshots, mode, activeSnapshot],
  );
  const graphData = useMemo(() => {
    if (ENABLE_GRAPH_DEBUG && showFallback) return getDebugFallbackData();
    return realGraphData;
  }, [realGraphData, showFallback]);
  const usingFallback = ENABLE_GRAPH_DEBUG && showFallback;

  // Keep selected node in sync with visible nodes
  const visibleSelectedNode = selectedNode && graphData.nodes.some(
    (n) => n.snapshotId === selectedNode.snapshotId && n.originalId === selectedNode.originalId,
  ) ? selectedNode : null;

  const selection = visibleSelectedNode
    ? buildNodeSelection(
        visibleSelectedNode,
        orderedSnapshots.find((s) => s.id === visibleSelectedNode.snapshotId),
        explanation,
      )
    : null;

  const baselineSnapshot = orderedSnapshots.length > 1 ? orderedSnapshots[0] : null;
  const categoryCounts = useMemo(
    () => CATEGORY_LEGEND.map((cat) => ({
      ...cat,
      count: graphData.nodes.filter((n) => n.category === cat.label).length,
    })),
    [graphData.nodes],
  );

  // Top concepts for concept mode sidebar
  const topConcepts = useMemo(() => {
    if (mode !== "concept") return [];
    return [...graphData.nodes]
      .sort((a, b) => (b.frequency ?? 1) - (a.frequency ?? 1))
      .slice(0, 6);
  }, [graphData.nodes, mode]);

  const modelLabel = activeSnapshot?.extraction_model && activeSnapshot.extraction_model !== "unknown"
    ? `${activeSnapshot.extraction_provider ?? "unknown"} / ${activeSnapshot.extraction_model}`
    : "model unknown";

  const temporalLabel = mode === "concept"
    ? `${orderedSnapshots.length} entries merged`
    : mode === "temporal" && baselineSnapshot && activeSnapshot
      ? `${baselineSnapshot.day} → ${activeSnapshot.day}`
      : activeSnapshot ? `${activeSnapshot.day}` : "No snapshots available";

  // Node 3D object factory
  const isConceptMode = mode === "concept";
  const createNodeObject = useCallback(
    (node: GraphViewerNode) => makeNodeObject(node, isConceptMode),
    [isConceptMode],
  );

  // Bloom post-processing — set up once after graph initializes
  const setupBloom = useCallback(() => {
    if (!fgRef.current || bloomSetupRef.current) return;
    try {
      const composer = (fgRef.current as unknown as { postProcessingComposer?: () => { addPass: (p: unknown) => void } }).postProcessingComposer?.();
      if (!composer) return;

      // Dynamic import keeps Three.js postprocessing out of the server bundle
      Promise.all([
        import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        import("three/examples/jsm/postprocessing/OutputPass.js"),
      ]).then(([{ UnrealBloomPass }, { OutputPass }]) => {
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(graphWidth, 680),
          1.4,   // strength
          0.45,  // radius
          0.18,  // threshold — only bright emissive cores bloom
        );
        composer.addPass(bloom);
        composer.addPass(new OutputPass());
        bloomSetupRef.current = true;
      }).catch(() => {});
    } catch {}
  }, [graphWidth]);

  // Reconfigure d3 forces when mode changes
  useEffect(() => {
    if (!fgRef.current) return;
    try {
      const charge = (fgRef.current as unknown as { d3Force: (name: string) => { strength: (v: number) => void } | null }).d3Force("charge");
      if (charge) charge.strength(mode === "concept" ? -280 : -120);
      (fgRef.current as unknown as { d3ReheatSimulation?: () => void }).d3ReheatSimulation?.();
    } catch {}
  }, [mode]);

  const handleEngineStop = useCallback(() => {
    if (!fgRef.current) return;
    setupBloom();
    const zDist = mode === "concept" ? 320 : 240;
    fgRef.current.cameraPosition({ x: 0, y: 0, z: zDist }, { x: 0, y: 0, z: 0 }, 600);
    fgRef.current.zoomToFit(mode === "concept" ? 1200 : 900, mode === "concept" ? 120 : 96);
  }, [setupBloom, mode]);

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      {/* ── Header ── */}
      <div className="border-b border-slate-200 bg-slate-50/80 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              <Orbit className="h-4 w-4 text-cyan-600" />
              {title}
            </div>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              {mode === "concept" ? "Concept network" : "Interactive 3D structural graph"}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {mode === "concept"
                ? "All snapshots merged into a persistent concept graph. Node size = recurrence frequency. Repeated concepts become large interconnected hubs — like Obsidian's graph view."
                : "Live extracted nodes plotted as a labeled 3D structure. Color encodes ontology class, arrows encode relation type, temporal mode stacks snapshots on the Z-axis."}
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-1">
            {ENABLE_GRAPH_DEBUG && (
              <button
                type="button"
                onClick={() => setShowFallback(!showFallback)}
                className={`rounded px-3 py-2 text-sm font-medium transition ${showFallback ? "bg-rose-500 text-white" : "text-slate-600 hover:bg-white"}`}
              >
                {showFallback ? "Hide Fallback" : "Debug"}
              </button>
            )}
            {(["current", "temporal", "concept"] as GraphMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setSelectedNode(null); }}
                className={`rounded px-3 py-2 text-sm font-medium capitalize transition ${
                  mode === m ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded border border-slate-200 bg-white px-3 py-1">Mode: {mode}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{temporalLabel}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">
            {graphData.nodes.length} nodes · {graphData.links.length} relations
          </span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{modelLabel}</span>
        </div>
      </div>

      {/* ── Main grid ── */}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.35fr)_360px]">

        {/* ── Graph canvas (dark space theme) ── */}
        <div
          className="relative min-h-[680px] overflow-hidden"
          style={{ background: "linear-gradient(180deg, #080c14 0%, #050a10 100%)" }}
        >
          {/* Subtle star field */}
          <div
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
              backgroundSize: "60px 60px",
            }}
          />

          <div className="pointer-events-none absolute left-5 top-5 z-10 rounded border border-white/10 bg-black/40 px-3 py-2 text-xs font-medium text-white/60 backdrop-blur">
            {mode === "concept" ? "Concept graph · orbit / zoom / click nodes" : "Graph3D projection · orbit / zoom / click nodes"}
          </div>

          <div ref={graphFrameRef} className="h-[680px] w-full">
            {graphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={graphData}
                backgroundColor="#080c14"
                nodeLabel={(node: GraphViewerNode) =>
                  mode === "concept"
                    ? `${node.label} · ${node.category} · ${node.frequency ?? 1}× (${node.allDays?.join(", ") ?? node.snapshotDay})`
                    : `${node.label} · ${node.category} · ${node.snapshotDay}`
                }
                nodeThreeObject={createNodeObject}
                nodeThreeObjectExtend={false}
                nodeColor={(node: GraphViewerNode) => node.color}
                nodeVal={(node: GraphViewerNode) => node.radius * 10}
                linkColor={(link: GraphViewerLink) => link.color}
                linkWidth={(link: GraphViewerLink) => link.width * 0.9}
                linkOpacity={0.65}
                linkDirectionalArrowLength={(link: GraphViewerLink) => (link.type === "buffers" ? 2 : 5)}
                linkDirectionalArrowRelPos={0.92}
                linkDirectionalParticles={mode === "concept" ? 1 : 2}
                linkDirectionalParticleWidth={(link: GraphViewerLink) => Math.max(1.2, link.width * 0.6)}
                linkDirectionalParticleSpeed={0.005}
                linkCurvature={(link: GraphViewerLink) => (link.dashed ? 0.18 : 0.07)}
                nodeRelSize={9}
                enableNodeDrag={true}
                onNodeClick={(node: GraphViewerNode) => setSelectedNode(node)}
                onBackgroundClick={() => setSelectedNode(null)}
                controlType="orbit"
                warmupTicks={mode === "concept" ? 220 : 80}
                cooldownTicks={mode === "concept" ? 180 : 100}
                showNavInfo={false}
                width={graphWidth}
                height={680}
                onEngineStop={handleEngineStop}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-white/20">
                No graph data yet. Submit a journal entry to render the structural graph.
              </div>
            )}
          </div>

          {/* Category dot legend — top-right of canvas */}
          {graphData.nodes.length > 0 && (
            <div className="pointer-events-none absolute right-4 top-4 z-10 flex flex-col gap-1.5 rounded border border-white/10 bg-black/40 px-3 py-2.5 backdrop-blur">
              {CATEGORY_LEGEND.map((cat) => (
                <div key={cat.label} className="flex items-center gap-2 text-[11px] text-white/60">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cat.color, boxShadow: `0 0 4px ${cat.color}` }} />
                  {cat.label}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <aside className="space-y-4 border-l border-slate-200 bg-slate-50 p-5">

          {/* Overview */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <ArrowLeftRight className="h-4 w-4 text-cyan-600" />
              {mode === "concept" ? "Concept network" : "Baseline vs current"}
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              {mode === "concept" ? (
                <>
                  <div>Entries merged: {orderedSnapshots.length}</div>
                  <div>Unique concepts: {graphData.nodes.length}</div>
                  <div>Total relations: {graphData.links.length}</div>
                  <div>Span: {orderedSnapshots[0]?.day ?? "—"} → {orderedSnapshots.at(-1)?.day ?? "—"}</div>
                </>
              ) : (
                <>
                  <div>Snapshots: {orderedSnapshots.length}</div>
                  <div>Baseline layer: {baselineSnapshot?.day ?? "n/a"}</div>
                  <div>Current layer: {activeSnapshot?.day ?? "n/a"}</div>
                  <div>Source: {usingFallback ? "debug fallback" : "live snapshots"}</div>
                </>
              )}
            </div>
          </div>

          {/* Ontology basis / top concepts */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Box className="h-4 w-4 text-cyan-600" />
              {mode === "concept" ? "Top concepts" : "Ontology basis"}
            </div>
            <div className="mt-4 space-y-3">
              {mode === "concept" ? (
                topConcepts.map((node) => (
                  <div key={node.originalId} className="grid grid-cols-[1fr_28px] items-center gap-2 text-xs text-slate-600">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: node.color }} />
                      <span className="truncate">{node.label}</span>
                    </div>
                    <div className="text-right tabular-nums text-slate-400">{node.frequency}×</div>
                  </div>
                ))
              ) : (
                categoryCounts.map((item) => (
                  <div key={item.label} className="grid grid-cols-[96px_1fr_24px] items-center gap-3 text-xs text-slate-600">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      {item.label}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${graphData.nodes.length ? Math.max(8, (item.count / graphData.nodes.length) * 100) : 0}%`,
                          backgroundColor: item.color,
                        }}
                      />
                    </div>
                    <div className="text-right tabular-nums text-slate-500">{item.count}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Selected node */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Info className="h-4 w-4 text-cyan-600" />
              Selected node
            </div>
            {selection ? (
              <div className="mt-3 space-y-3 text-sm text-slate-700">
                <div>
                  <div className="font-medium text-slate-950">{selection.node.label}</div>
                  <div className="text-xs text-slate-500">{selection.roleSummary}</div>
                </div>
                <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600 space-y-1">
                  <div>Category: {selection.node.category}</div>
                  <div>Intensity: {selection.node.intensity.toFixed(2)}</div>
                  <div>Confidence: {selection.node.confidence.toFixed(2)}</div>
                  {selection.node.frequency && <div>Frequency: {selection.node.frequency}× across {selection.node.allDays?.length} days</div>}
                  {selection.node.allDays && (
                    <div className="text-slate-400">Days: {selection.node.allDays.join(", ")}</div>
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Structural role</div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-600">
                    {selection.relationSummary.map((item) => <li key={item}>• {item}</li>)}
                    {selection.anomalySignals.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-500">Click a node to inspect its metadata and structural role.</div>
            )}
          </div>

          {/* How to read */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <RotateCw className="h-4 w-4 text-cyan-600" />
              {mode === "concept" ? "How concept mode works" : "How to read this"}
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              {mode === "concept" ? (
                <>
                  <p>All journal snapshots are merged. Identical concepts collapse into a single node.</p>
                  <p><strong>Node size</strong> = how many entries mention this concept. Frequent concepts become large hubs.</p>
                  <p><strong>Edge thickness</strong> = how many times this relation appeared across all entries.</p>
                  <p>The resulting dense web is analogous to Obsidian's knowledge graph.</p>
                  <p className="flex items-center gap-1 text-cyan-700 font-medium">
                    <Cpu className="h-3 w-3" /> More entries → richer, denser graph.
                  </p>
                </>
              ) : (
                <>
                  <p>Node color encodes ontology class.</p>
                  <p>Relation styling encodes relation type.</p>
                  <p>Temporal mode stacks snapshots on the Z-axis so drift across time is visible.</p>
                  <p>Switch to <strong>Concept</strong> mode to see the merged cross-entry knowledge graph.</p>
                </>
              )}
              {usingFallback && <p className="text-rose-600">Debug fallback is active.</p>}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
