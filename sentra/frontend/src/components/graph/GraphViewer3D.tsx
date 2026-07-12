"use client";

import dynamic from "next/dynamic";
import type { ComponentType, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphSnapshot, ExplanationPayload } from "@/api/models";
import { ArrowLeftRight, Box, Cpu, Info, Orbit, Route, RotateCw, ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
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

const MODE_COPY: Record<GraphMode, { label: string; title: string; description: string; canvasHint: string }> = {
  current: {
    label: "Snapshot",
    title: "Current Entry Graph",
    description: "A typed directed multigraph for the selected entry: nodes are extracted observations, categories are ontology types, and arrows show relation direction. Multiple relation types can connect the same pair.",
    canvasHint: "Current entry graph · orbit / zoom / inspect",
  },
  temporal: {
    label: "Temporal",
    title: "Time-Layered Graph",
    description: "Entry graphs are stacked by day so changes can be inspected over time. Z position encodes chronology; XY position is a force layout for readability, not a measured psychological distance.",
    canvasHint: "Time-layered graph · orbit / zoom / inspect",
  },
  concept: {
    label: "Concepts",
    title: "Recurring Concept Graph",
    description: "Repeated labels with the same ontology class are collapsed across entries. Larger nodes and thicker edges mean recurrence in the participant record, not clinical certainty.",
    canvasHint: "Recurring concept graph · orbit / zoom / inspect",
  },
};

interface GraphViewer3DProps {
  snapshots: GraphSnapshot[];
  currentSnapshot?: GraphSnapshot | null;
  explanation?: ExplanationPayload | null;
  title?: string;
}

function makeNodeObject(node: GraphViewerNode, isConceptMode: boolean) {
  const group = new THREE.Group();
  const color = new THREE.Color(node.color);
  const dim = node.sourceKind === "historical";
  const recurrence = node.frequency ?? 1;
  const isHighSalience = isConceptMode ? recurrence >= 3 : node.intensity >= 0.8;

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 0.78, 20, 14),
    new THREE.MeshStandardMaterial({
      color,
      emissive: isHighSalience ? color : new THREE.Color("#000000"),
      emissiveIntensity: dim ? 0.08 : isHighSalience ? 0.35 : 0.0,
      roughness: 0.72,
      metalness: 0.05,
      transparent: dim,
      opacity: dim ? 0.45 : 1,
    }),
  );
  group.add(core);

  if (isHighSalience) {
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(node.radius * 1.45, 12, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: dim ? 0.04 : 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(halo);
  }

  const outline = new THREE.Mesh(
    new THREE.SphereGeometry(node.radius * 0.82, 20, 14),
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: dim ? 0.12 : 0.28,
    }),
  );
  group.add(outline);

  // Labels only on concept-mode hub nodes (freq >= 3) — shown as subtle glowing text
  if (isConceptMode && recurrence >= 3) {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 56;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = "500 22px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      const label = node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label;
      ctx.fillText(label, 192, 28);
    }
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.position.set(0, node.radius * 2.4 + 5, 0);
    sprite.scale.set(28, 6, 1);
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
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    overview: false,
    ontology: false,
    edges: false,
    pipeline: false,
    howToRead: false,
    precision: false,
    inspector_history: false,
  });

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const fgRef = useRef<ForceGraphMethods | null>(null);
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const modeCopy = MODE_COPY[mode];

  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => `${a.day}`.localeCompare(`${b.day}`)),
    [snapshots],
  );
  const activeSnapshot = currentSnapshot ?? orderedSnapshots.at(-1) ?? null;

  // Responsive width — only update when the measurement is actually meaningful (>0)
  useEffect(() => {
    const frame = graphFrameRef.current;
    if (!frame) return;
    const update = () => {
      const w = Math.floor(frame.getBoundingClientRect().width);
      if (w > 0) setGraphWidth(w);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(frame);
    return () => obs.disconnect();
  }, [isSidebarCollapsed]);

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

  // Filtered graph data when focused on a node
  const focusedGraphData = useMemo(() => {
    if (!focusNodeId) return graphData;

    const neighbors = new Set<string>();
    neighbors.add(focusNodeId);

    graphData.links.forEach((link) => {
      const sourceId = typeof link.source === "object" ? (link.source as { id: string }).id : link.source;
      const targetId = typeof link.target === "object" ? (link.target as { id: string }).id : link.target;

      if (sourceId === focusNodeId) {
        if (targetId) neighbors.add(targetId);
      } else if (targetId === focusNodeId) {
        if (sourceId) neighbors.add(sourceId);
      }
    });

    const filteredNodes = graphData.nodes.filter((node) => neighbors.has(node.id));
    const filteredLinks = graphData.links.filter((link) => {
      const sourceId = typeof link.source === "object" ? (link.source as { id: string }).id : link.source;
      const targetId = typeof link.target === "object" ? (link.target as { id: string }).id : link.target;
      return sourceId === focusNodeId || targetId === focusNodeId;
    });

    return {
      nodes: filteredNodes,
      links: filteredLinks,
    };
  }, [graphData, focusNodeId]);

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

  // Reconfigure d3 forces when mode changes
  useEffect(() => {
    if (!fgRef.current) return;
    try {
      const charge = (fgRef.current as unknown as { d3Force: (name: string) => { strength: (v: number) => void } | null }).d3Force("charge");
      if (charge) charge.strength(mode === "concept" ? -120 : -80);
      (fgRef.current as unknown as { d3ReheatSimulation?: () => void }).d3ReheatSimulation?.();
    } catch {}
  }, [mode]);

  const handleEngineStop = useCallback(() => {
    if (!fgRef.current) return;
    // Reset to a neutral forward-facing angle instantly, then animate zoom-to-fit
    fgRef.current.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 }, 0);
    fgRef.current.zoomToFit(800, 60);
  }, []);

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
              {modeCopy.title}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {modeCopy.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-1">
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
                onClick={() => { setMode(m); setSelectedNode(null); setFocusNodeId(null); }}
                className={`rounded px-3 py-2 text-sm font-medium capitalize transition ${
                  mode === m ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
                }`}
              >
                {MODE_COPY[m].label}
              </button>
            ))}
            <div className="mx-1 h-6 w-[1px] bg-slate-200" />
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white transition"
              title={isSidebarCollapsed ? "Show Sidebar Panel" : "Hide Sidebar Panel"}
            >
              {isSidebarCollapsed ? (
                <>
                  <Minimize2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Show Sidebar</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Maximize Graph</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded border border-slate-200 bg-white px-3 py-1">View: {modeCopy.title}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{temporalLabel}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">
            {graphData.nodes.length} entities · {graphData.links.length} predicates
          </span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{modelLabel}</span>
          <span className="rounded border border-amber-200 bg-amber-50 px-3 py-1 text-amber-800">
            Layout is visual; it is not diagnostic.
          </span>
        </div>
      </div>

      {/* ── Main grid ── */}
      <div className={`grid gap-0 transition-all duration-300 ${isSidebarCollapsed ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1.35fr)_360px]"}`}>

        {/* ── Graph canvas (dark space theme) ── */}
        <div
          className="relative min-h-[680px] overflow-hidden"
          style={{ background: "#020208" }}
        >
          <div className="pointer-events-none absolute left-5 top-5 z-10 rounded border border-white/10 bg-black/40 px-3 py-2 text-xs font-medium text-white/60 backdrop-blur">
            {modeCopy.canvasHint}
          </div>

          {focusNodeId && (
            <div className="absolute left-5 top-14 z-10 flex items-center gap-2.5 rounded border border-cyan-500/30 bg-cyan-950/80 px-3.5 py-2 text-xs font-medium text-cyan-200 backdrop-blur">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
              <span>Focusing neighbors of: <strong>{graphData.nodes.find(n => n.id === focusNodeId)?.label || "selected node"}</strong></span>
              <button
                type="button"
                onClick={() => setFocusNodeId(null)}
                className="ml-2 rounded bg-cyan-800/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-50 hover:bg-cyan-700 transition"
              >
                Clear
              </button>
            </div>
          )}

          <div ref={graphFrameRef} className="h-[680px] w-full">
            {focusedGraphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={focusedGraphData}
                backgroundColor="#020208"
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
                linkWidth={(link: GraphViewerLink) => link.width}
                linkOpacity={(link: GraphViewerLink) => link.opacity}
                linkDirectionalArrowLength={(link: GraphViewerLink) => (link.type === "buffers" ? 1.5 : 3)}
                linkDirectionalArrowRelPos={0.9}
                linkDirectionalParticles={1}
                linkDirectionalParticleWidth={(link: GraphViewerLink) => Math.max(0.8, link.width * 0.5)}
                linkDirectionalParticleSpeed={0.004}
                linkCurvature={(link: GraphViewerLink) => (link.dashed ? 0.15 : 0.05)}
                linkLineDash={(link: GraphViewerLink) => link.dashed ? [4, 3] : undefined}
                nodeRelSize={9}
                enableNodeDrag={false}
                onNodeClick={(node: GraphViewerNode) => setSelectedNode(node)}
                onNodeDoubleClick={(node: GraphViewerNode) => setFocusNodeId(focusNodeId === node.id ? null : node.id)}
                onBackgroundClick={() => setSelectedNode(null)}
                controlType="orbit"
                warmupTicks={mode === "concept" ? 100 : 80}
                cooldownTicks={mode === "concept" ? 120 : 100}
                showNavInfo={false}
                width={graphWidth}
                height={680}
                onEngineStop={handleEngineStop}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-white/20">
                No ontology graph nodes match. Clear filters or submit an observation to render.
              </div>
            )}
          </div>

          {/* Category dot legend — top-right of canvas */}
          {focusedGraphData.nodes.length > 0 && (
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
        {!isSidebarCollapsed && (
          <aside className="space-y-4 border-l border-slate-200 bg-slate-50 p-5 max-h-[680px] overflow-y-auto">

            {/* Selected node / Entity Inspector — ALWAYS at the top */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("inspector")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <Info className="h-4 w-4 text-cyan-600" />
                  Entity Inspector
                </div>
                {collapsedSections.inspector ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>

              {!collapsedSections.inspector && (
                <div className="border-t border-slate-100 p-5 pt-4">
                  {selection ? (
                    <div className="space-y-3 text-sm text-slate-700">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-950 truncate">{selection.node.label}</div>
                          <div className="text-xs text-slate-500">{selection.roleSummary}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFocusNodeId(focusNodeId === selection.node.id ? null : selection.node.id)}
                          className={`shrink-0 rounded px-2.5 py-1 text-xs font-semibold shadow-sm border transition ${
                            focusNodeId === selection.node.id
                              ? "bg-cyan-600 text-white border-cyan-600 hover:bg-cyan-700"
                              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          {focusNodeId === selection.node.id ? "Unfocus" : "Focus Neighbors"}
                        </button>
                      </div>

                      <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600 space-y-1">
                        <div>Category: {selection.node.category}</div>
                        <div>Intensity: {selection.node.intensity.toFixed(2)}</div>
                        <div>Confidence: {selection.node.confidence.toFixed(2)}</div>
                        {selection.node.frequency && <div>Frequency: {selection.node.frequency}× across {selection.node.allDays?.length} days</div>}
                      </div>

                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Ontological role</div>
                        <ul className="mt-2 space-y-1 text-xs text-slate-600">
                          {selection.relationSummary.map((item) => <li key={item}>• {item}</li>)}
                          {selection.anomalySignals.map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      </div>

                      {selection.node.allDays && selection.node.allDays.length > 0 && (
                        <div className="border-t border-slate-100 pt-3">
                          <button
                            type="button"
                            onClick={() => toggleSection("inspector_history")}
                            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-700 transition"
                          >
                            <span>Appearance History ({selection.node.allDays.length})</span>
                            {collapsedSections.inspector_history ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronUp className="h-3.5 w-3.5 text-slate-400" />}
                          </button>
                          {!collapsedSections.inspector_history && (
                            <div className="mt-2 max-h-32 overflow-y-auto space-y-1.5 pr-1 text-xs">
                              {selection.node.allDays.map((dayString) => (
                                <div key={dayString} className="rounded bg-slate-50 p-2 border border-slate-100">
                                  <div className="font-semibold text-slate-600">{dayString}</div>
                                  <div className="mt-0.5 text-slate-400">
                                    Intensity: {selection.node.intensity.toFixed(2)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">Click an entity to inspect its metadata and ontological role.</div>
                  )}
                </div>
              )}
            </div>

            {/* Overview */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("overview")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <ArrowLeftRight className="h-4 w-4 text-cyan-600" />
                  {modeCopy.title}
                </div>
                {collapsedSections.overview ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>
              {!collapsedSections.overview && (
                <div className="border-t border-slate-100 p-5 pt-4 space-y-2 text-sm text-slate-700">
                  {mode === "concept" ? (
                    <>
                      <div>Entries merged: {orderedSnapshots.length}</div>
                      <div>Unique concepts: {graphData.nodes.length}</div>
                      <div>Total predicates: {graphData.links.length}</div>
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
              )}
            </div>

            {/* Ontology basis / top concepts */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("ontology")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <Box className="h-4 w-4 text-cyan-600" />
                  {mode === "concept" ? "Concept Salience" : "Ontological Basis"}
                </div>
                {collapsedSections.ontology ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>
              {!collapsedSections.ontology && (
                <div className="border-t border-slate-100 p-5 pt-4 space-y-3">
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
              )}
            </div>

            {/* Edge Semantics */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("edges")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <Route className="h-4 w-4 text-cyan-600" />
                  Edge Semantics
                </div>
                {collapsedSections.edges ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>
              {!collapsedSections.edges && (
                <div className="border-t border-slate-100 p-5 pt-4 space-y-2 text-sm text-slate-600">
                  <p><strong>Arrow</strong> = relation direction from source to target.</p>
                  <p><strong>Color</strong> = relation type (causes, escalates, buffers, avoids, co-occurs, precedes).</p>
                  <p><strong>Width</strong> = confidence in snapshot mode; recurrence in concept mode.</p>
                </div>
              )}
            </div>

            {/* Construction Pipeline */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("pipeline")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <Cpu className="h-4 w-4 text-cyan-600" />
                  Construction Pipeline
                </div>
                {collapsedSections.pipeline ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>
              {!collapsedSections.pipeline && (
                <div className="border-t border-slate-100 p-5 pt-4 space-y-2 text-sm text-slate-600">
                  <p><strong>1. Extract</strong> observations and candidate relations from text.</p>
                  <p><strong>2. Validate</strong> against BLESC ontology rules.</p>
                  <p><strong>3. Store</strong> snapshot with day and model metadata.</p>
                  <p><strong>4. Render</strong> layout structure.</p>
                </div>
              )}
            </div>

            {/* How to read */}
            <div className="rounded-lg border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => toggleSection("howToRead")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-slate-700 hover:bg-slate-50/50 transition"
              >
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  <RotateCw className="h-4 w-4 text-cyan-600" />
                  {mode === "concept" ? "Quotient Graph Semantics" : "Reading the Graph"}
                </div>
                {collapsedSections.howToRead ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
              </button>
              {!collapsedSections.howToRead && (
                <div className="border-t border-slate-100 p-5 pt-4 space-y-2 text-sm text-slate-600">
                  {mode === "concept" ? (
                    <>
                      <p>Identical entity labels collapse into one recurring concept node.</p>
                      <p><strong>Node size</strong> = appearance frequency.</p>
                      <p><strong>Edge thickness</strong> = relation pattern recurrence.</p>
                    </>
                  ) : (
                    <>
                      <p>Nodes are extracted observations (State, Trigger, Behavior, Event, Protective).</p>
                      <p>Temporal mode uses Z-axis for chronology.</p>
                      <p>Double-click a node to focus on its direct neighborhood.</p>
                    </>
                  )}
                  {usingFallback && <p className="text-rose-600 font-medium">Debug fallback active.</p>}
                </div>
              )}
            </div>

            {/* Precision Boundary */}
            <div className="rounded-lg border border-amber-200 bg-amber-50">
              <button
                type="button"
                onClick={() => toggleSection("precision")}
                className="flex w-full items-center justify-between p-5 text-left font-semibold text-amber-800 hover:bg-amber-100/50 transition"
              >
                <div className="text-sm font-semibold uppercase tracking-[0.16em]">
                  Precision Boundary
                </div>
                {collapsedSections.precision ? <ChevronDown className="h-4 w-4 text-amber-600" /> : <ChevronUp className="h-4 w-4 text-amber-600" />}
              </button>
              {!collapsedSections.precision && (
                <div className="border-t border-amber-100 p-5 pt-4 space-y-2 text-sm text-amber-900">
                  <p>The graph is precise as a structured pattern record, not as clinical diagnosis.</p>
                  <p>Use confidence, recurrence, and relation types together. A single node or edge is not definitive proof.</p>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
