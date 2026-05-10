"use client";

import dynamic from "next/dynamic";
import type { ComponentType, MutableRefObject } from "react";
import { useMemo, useRef, useState } from "react";
import { GraphSnapshot, ExplanationPayload } from "@/api/models";
import { ArrowLeftRight, Info, Orbit, RotateCw } from "lucide-react";
import * as THREE from "three";
import type { ForceGraphMethods } from "react-force-graph-3d";
import type { GraphMode, GraphViewerLink, GraphViewerNode } from "./graphTypes";
import { buildGraphViewerData, buildNodeSelection, getDebugFallbackData } from "./graphAdapter";

type ForceGraphBoundaryProps = Record<string, unknown> & {
  ref?: MutableRefObject<ForceGraphMethods | null>;
};

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false }) as unknown as ComponentType<ForceGraphBoundaryProps>;
const ENABLE_GRAPH_DEBUG = process.env.NEXT_PUBLIC_ENABLE_GRAPH_DEBUG === "true";

interface GraphViewer3DProps {
  snapshots: GraphSnapshot[];
  currentSnapshot?: GraphSnapshot | null;
  explanation?: ExplanationPayload | null;
  title?: string;
}

export function GraphViewer3D({
  snapshots,
  currentSnapshot,
  explanation,
  title = "Local graph viewer",
}: GraphViewer3DProps) {
  const [mode, setMode] = useState<GraphMode>("current");
  const [selectedNode, setSelectedNode] = useState<GraphViewerNode | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const fgRef = useRef<ForceGraphMethods | null>(null);

  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => `${a.day}`.localeCompare(`${b.day}`)),
    [snapshots],
  );

  const activeSnapshot = currentSnapshot ?? orderedSnapshots.at(-1) ?? null;
  const realGraphData = useMemo(() => buildGraphViewerData(orderedSnapshots, mode, activeSnapshot), [orderedSnapshots, mode, activeSnapshot]);
  const graphData = useMemo(() => {
    if (ENABLE_GRAPH_DEBUG && showFallback) {
      return getDebugFallbackData();
    }
    return realGraphData;
  }, [realGraphData, showFallback]);
  const usingFallback = ENABLE_GRAPH_DEBUG && showFallback;

  const visibleSelectedNode = selectedNode && graphData.nodes.some(
    (node) => node.snapshotId === selectedNode.snapshotId && node.originalId === selectedNode.originalId,
  ) ? selectedNode : null;

  const selection = visibleSelectedNode
    ? buildNodeSelection(
        visibleSelectedNode,
        orderedSnapshots.find((snapshot) => snapshot.id === visibleSelectedNode.snapshotId),
        explanation,
      )
    : null;

  const baselineSnapshot = orderedSnapshots.length > 1 ? orderedSnapshots[0] : null;
  const temporalLabel =
    mode === "temporal" && baselineSnapshot && activeSnapshot
      ? `${baselineSnapshot.day} → ${activeSnapshot.day}`
      : activeSnapshot
        ? `${activeSnapshot.day}`
        : "No snapshots available";

  return (
    <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            <Orbit className="h-4 w-4 text-cyan-600" />
            {title}
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">Interactive 3D structural graph</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            This is a visualization layer only. The anomaly decision still comes from graph-native inference; the viewer is for inspection, baseline comparison, and temporal shifts.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1">
          {ENABLE_GRAPH_DEBUG && (
            <button
              type="button"
              onClick={() => setShowFallback(!showFallback)}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                showFallback ? "bg-rose-500 text-white" : "text-slate-600 hover:bg-white"
              }`}
            >
              {showFallback ? "Hide Fallback" : "Debug Fallback"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("current")}
            className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
              mode === "current" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
            }`}
          >
            Current
          </button>
          <button
            type="button"
            onClick={() => setMode("temporal")}
            className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
              mode === "temporal" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
            }`}
          >
            Temporal
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-3 py-1">Mode: {mode}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1">Layer view: {temporalLabel}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1">Drag / rotate / zoom enabled</span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="min-h-[620px] overflow-hidden rounded-[1.75rem] border border-slate-200 bg-slate-950">
          <div className="h-[620px] w-full">
            {graphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={graphData}
                backgroundColor="#020617"
                nodeLabel={(node: GraphViewerNode) =>
                  `${node.label} · ${node.category} · ${node.snapshotDay}${node.layerIndex >= 0 ? ` · layer ${node.layerIndex + 1}` : ""}`
                }
                nodeColor={(node: GraphViewerNode) => node.color}
                nodeVal={(node: GraphViewerNode) => node.radius * 2.2}
                nodeThreeObject={(node: GraphViewerNode) => {
                  const material = new THREE.MeshStandardMaterial({
                    color: node.color,
                    emissive: node.color,
                    emissiveIntensity: 0.22,
                    roughness: 0.25,
                    metalness: 0.08,
                    transparent: true,
                    opacity: 0.98,
                  });
                  return new THREE.Mesh(new THREE.SphereGeometry(Math.max(2.8, node.radius * 0.95), 24, 24), material);
                }}
                linkColor={(link: GraphViewerLink) => link.color}
                linkWidth={(link: GraphViewerLink) => link.width}
                linkOpacity={0.88}
                linkDirectionalArrowLength={(link: GraphViewerLink) => (link.type === "buffers" ? 0 : 3)}
                linkDirectionalArrowRelPos={0.92}
                nodeRelSize={9}
                enableNodeDrag={true}
                onNodeClick={(node: GraphViewerNode) => setSelectedNode(node)}
                onBackgroundClick={() => setSelectedNode(null)}
                controlType="orbit"
                warmupTicks={120}
                cooldownTicks={120}
                showNavInfo={false}
                height={620}
                onEngineStop={() => {
                  if (!fgRef.current) return;
                  const distance = Math.max(220, graphData.nodes.length * 130);
                  fgRef.current.cameraPosition({ x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 1200);
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-slate-300">
                No graph data yet. Submit a journal entry with events, supports, stressors, or changes to render the structural graph.
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-[1.75rem] border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <ArrowLeftRight className="h-4 w-4 text-cyan-600" />
              Baseline vs current
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              <div>Snapshots: {orderedSnapshots.length}</div>
              <div>Baseline layer: {baselineSnapshot?.day ?? "n/a"}</div>
              <div>Current layer: {activeSnapshot?.day ?? "n/a"}</div>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-slate-200 bg-white p-5">
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
                <div className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">
                  <div>Category: {selection.node.category}</div>
                  <div>Intensity: {selection.node.intensity.toFixed(2)}</div>
                  <div>Confidence: {selection.node.confidence.toFixed(2)}</div>
                  <div>Original id: {selection.node.originalId}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Role in anomaly/explanation</div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-600">
                    {selection.relationSummary.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                    {selection.anomalySignals.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-500">Click a node to inspect its metadata and structural role.</div>
            )}
          </div>

          <div className="rounded-[1.75rem] border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <RotateCw className="h-4 w-4 text-cyan-600" />
              How to read this
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p>Node color encodes ontology class.</p>
              <p>Relation styling encodes relation type.</p>
              <p>Temporal mode stacks snapshots on the z-axis so shifts across time are visible.</p>
              <p>Use the graph to inspect structural change points, not to decide the anomaly itself.</p>
              <p>Node-only snapshots still render as bright spheres with camera framing tuned to keep them visible.</p>
              {usingFallback && <p className="text-rose-600">Debug fallback is active.</p>}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
