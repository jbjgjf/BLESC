"use client";

import dynamic from "next/dynamic";
import type { ComponentType, MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphSnapshot, ExplanationPayload } from "@/api/models";
import { ArrowLeftRight, Box, Cpu, Info, Orbit, Route, RotateCw } from "lucide-react";
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
    title: "Typed Directed Multigraph",
    description: "One snapshot rendered as typed vertices and directed predicate edges. Vertex color encodes ontology class; arrows encode predicate direction.",
    canvasHint: "Typed directed multigraph · orbit / zoom / inspect",
  },
  temporal: {
    label: "Temporal",
    title: "Layered Temporal Digraph",
    description: "Snapshots are stacked as time layers on the Z-axis. Z position encodes date; XY position is layout-only for readability.",
    canvasHint: "Layered temporal digraph · orbit / zoom / inspect",
  },
  concept: {
    label: "Quotient",
    title: "Concept Quotient Graph",
    description: "Repeated entities with the same ontology class and label collapse into one recurrent concept vertex across snapshots.",
    canvasHint: "Concept quotient graph · orbit / zoom / inspect",
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
                {MODE_COPY[m].label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded border border-slate-200 bg-white px-3 py-1">View: {modeCopy.title}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{temporalLabel}</span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">
            {graphData.nodes.length} entities · {graphData.links.length} predicates
          </span>
          <span className="rounded border border-slate-200 bg-white px-3 py-1">{modelLabel}</span>
        </div>
      </div>

      {/* ── Main grid ── */}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.35fr)_360px]">

        {/* ── Graph canvas (dark space theme) ── */}
        <div
          className="relative min-h-[680px] overflow-hidden"
          style={{ background: "#020208" }}
        >
          <div className="pointer-events-none absolute left-5 top-5 z-10 rounded border border-white/10 bg-black/40 px-3 py-2 text-xs font-medium text-white/60 backdrop-blur">
            {modeCopy.canvasHint}
          </div>
          <div ref={graphFrameRef} className="h-[680px] w-full">
            {graphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={graphData}
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
                No ontology graph yet. Submit an observation to render the typed directed multigraph.
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
              {modeCopy.title}
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
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
          </div>

          {/* Ontology basis / top concepts */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Box className="h-4 w-4 text-cyan-600" />
              {mode === "concept" ? "Concept Salience" : "Ontological Basis"}
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

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Route className="h-4 w-4 text-cyan-600" />
              Edge Semantics
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p><strong>Arrow</strong> = predicate direction from source vertex to target vertex.</p>
              <p><strong>Color</strong> = predicate type.</p>
              <p><strong>Width</strong> = confidence in snapshot mode; recurrence in quotient mode.</p>
              <p><strong>Length</strong> = layout-only, with no semantic value.</p>
            </div>
          </div>

          {/* Selected node */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Info className="h-4 w-4 text-cyan-600" />
              Entity Inspector
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
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Ontological role</div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-600">
                    {selection.relationSummary.map((item) => <li key={item}>• {item}</li>)}
                    {selection.anomalySignals.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-500">Click an entity to inspect its metadata and ontological role.</div>
            )}
          </div>

          {/* How to read */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <RotateCw className="h-4 w-4 text-cyan-600" />
              {mode === "concept" ? "Quotient Graph Semantics" : "Reading the Ontology Graph"}
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              {mode === "concept" ? (
                <>
                  <p>All snapshots are merged. Identical entity labels within the same ontology class collapse into one recurrent concept vertex.</p>
                  <p><strong>Vertex size</strong> = concept recurrence across the participant record.</p>
                  <p><strong>Edge thickness</strong> = predicate recurrence across entries.</p>
                  <p>The result is a quotient graph, not a formal mathematical lattice.</p>
                  <p className="flex items-center gap-1 text-cyan-700 font-medium">
                    <Cpu className="h-3 w-3" /> More entries → richer ontology topology.
                  </p>
                </>
              ) : (
                <>
                  <p>Vertices are extracted entities. Directed edges are predicates.</p>
                  <p>Temporal mode uses Z-axis position for time layers; XY position is layout-only.</p>
                  <p>Edge length is layout-only and has no semantic value.</p>
                  <p>Drag is disabled to preserve a stable analytical layout.</p>
                  <p>Switch to <strong>Quotient</strong> mode to see repeated concepts collapsed across entries.</p>
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
