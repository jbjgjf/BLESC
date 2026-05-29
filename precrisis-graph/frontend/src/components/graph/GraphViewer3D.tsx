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
import { useTheme } from "@/app/context/ThemeContext";

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
  const { theme } = useTheme();
  const [mode, setMode] = useState<GraphMode>("current");
  const [selectedNode, setSelectedNode] = useState<GraphViewerNode | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const fgRef = useRef<ForceGraphMethods | null>(null);

  const isDark = theme === "dark";

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
    <section className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
            <Orbit className="h-4 w-4 text-notion-accent" />
            <span>{title}</span>
          </div>
          <h2 className="text-xl font-bold text-notion-text">Interactive 3D Graph Model</h2>
          <p className="max-w-2xl text-xs text-notion-muted leading-relaxed">
            Visualization of graph-native structural drift. Use this canvas to inspect nodes, temporal relationships, and stack baseline deviations across active days.
          </p>
        </div>

        {/* Notion Tab-style buttons */}
        <div className="flex items-center gap-1 rounded bg-notion-sidebar-bg border border-notion-border p-1">
          {ENABLE_GRAPH_DEBUG && (
            <button
              type="button"
              onClick={() => setShowFallback(!showFallback)}
              className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                showFallback ? "bg-red-500 text-white" : "text-notion-muted hover:bg-notion-hover-bg"
              }`}
            >
              {showFallback ? "Hide Fallback" : "Debug Fallback"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("current")}
            className={`rounded px-3 py-1 text-xs font-semibold transition-all duration-150 ${
              mode === "current"
                ? "bg-notion-accent text-white font-bold"
                : "text-notion-muted hover:bg-notion-hover-bg"
            }`}
          >
            Current
          </button>
          <button
            type="button"
            onClick={() => setMode("temporal")}
            className={`rounded px-3 py-1 text-xs font-semibold transition-all duration-150 ${
              mode === "temporal"
                ? "bg-notion-accent text-white font-bold"
                : "text-notion-muted hover:bg-notion-hover-bg"
            }`}
          >
            Temporal
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[10px] text-notion-muted font-mono">
        <span className="bg-notion-sidebar-bg border border-notion-border px-2 py-0.5 rounded">mode: {mode}</span>
        <span className="bg-notion-sidebar-bg border border-notion-border px-2 py-0.5 rounded">active view: {temporalLabel}</span>
        <span className="bg-notion-sidebar-bg border border-notion-border px-2 py-0.5 rounded">drag/zoom/rotate enabled</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="min-h-[500px] overflow-hidden rounded border border-notion-border bg-notion-sidebar-bg">
          <div className="h-[500px] w-full">
            {graphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={graphData}
                backgroundColor={isDark ? "#191919" : "#fafafa"}
                nodeLabel={(node: GraphViewerNode) =>
                  `${node.label} · ${node.category} · ${node.snapshotDay}${node.layerIndex >= 0 ? ` · layer ${node.layerIndex + 1}` : ""}`
                }
                nodeColor={(node: GraphViewerNode) => node.color}
                nodeVal={(node: GraphViewerNode) => node.radius * 2.2}
                nodeThreeObject={(node: GraphViewerNode) => {
                  const material = new THREE.MeshStandardMaterial({
                    color: node.color,
                    emissive: node.color,
                    emissiveIntensity: isDark ? 0.35 : 0.15,
                    roughness: 0.25,
                    metalness: 0.08,
                    transparent: true,
                    opacity: 0.95,
                  });
                  return new THREE.Mesh(new THREE.SphereGeometry(Math.max(2.8, node.radius * 0.95), 24, 24), material);
                }}
                linkColor={(link: GraphViewerLink) => link.color}
                linkWidth={(link: GraphViewerLink) => link.width}
                linkOpacity={isDark ? 0.88 : 0.65}
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
                height={500}
                onEngineStop={() => {
                  if (!fgRef.current) return;
                  const distance = Math.min(450, Math.max(200, graphData.nodes.length * 16));
                  fgRef.current.cameraPosition({ x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 1000);
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-xs text-notion-muted">
                No graph data. Submit a daily journal entry to extract nodes and links.
              </div>
            )}
          </div>
        </div>

        {/* Sidebar Info Panels */}
        <aside className="space-y-4">
          <div className="rounded border border-notion-sidebar-border bg-notion-sidebar-bg p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
              <ArrowLeftRight className="h-4 w-4 text-notion-accent" />
              <span>Snapshot Layers</span>
            </div>
            <div className="text-xs text-notion-text space-y-1">
              <div>Total snapshots: <span className="font-semibold">{orderedSnapshots.length}</span></div>
              {baselineSnapshot && <div>Baseline day: <span className="font-semibold">{baselineSnapshot.day}</span></div>}
              {activeSnapshot && <div>Current day: <span className="font-semibold">{activeSnapshot.day}</span></div>}
            </div>
          </div>

          <div className="rounded border border-notion-border bg-notion-card-bg p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
              <Info className="h-4 w-4 text-notion-accent" />
              <span>Selected Node Properties</span>
            </div>
            {selection ? (
              <div className="text-xs text-notion-text space-y-3">
                <div>
                  <div className="font-bold text-sm text-notion-text">{selection.node.label}</div>
                  <div className="text-[10px] text-notion-muted uppercase mt-0.5">{selection.roleSummary}</div>
                </div>
                <div className="rounded bg-notion-sidebar-bg border border-notion-border p-2.5 text-[11px] text-notion-muted space-y-1">
                  <div>Category: <span className="font-medium text-notion-text">{selection.node.category}</span></div>
                  <div>Intensity: <span className="font-medium text-notion-text">{selection.node.intensity.toFixed(2)}</span></div>
                  <div>Confidence: <span className="font-medium text-notion-text">{selection.node.confidence.toFixed(2)}</span></div>
                  <div>ID: <span className="font-mono text-notion-text">{selection.node.originalId}</span></div>
                </div>
                <div className="space-y-1.5 pt-1.5 border-t border-notion-border">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-notion-muted">Diagnostic Role</div>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] text-notion-muted">
                    {selection.relationSummary.map((item) => (
                      <li key={item} className="leading-relaxed">{item}</li>
                    ))}
                    {selection.anomalySignals.map((item) => (
                      <li key={item} className="leading-relaxed">{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="text-xs text-notion-muted leading-relaxed">
                Click a node inside the 3D model to inspect its properties and contribution to baseline anomalies.
              </div>
            )}
          </div>

          <div className="rounded border border-notion-sidebar-border bg-notion-sidebar-bg p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
              <RotateCw className="h-4 w-4 text-notion-accent" />
              <span>Legend</span>
            </div>
            <div className="text-[11px] text-notion-muted space-y-1.5 leading-relaxed">
              <p>• Node size indicates extraction intensity.</p>
              <p>• Node color encodes ontology class (State, Trigger, Event, etc.).</p>
              <p>• Temporal mode stacks snapshots along the vertical depth (Z-axis) to capture drift shifts over time.</p>
              {usingFallback && <p className="text-red-500 font-semibold">Debug fallback is active.</p>}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
