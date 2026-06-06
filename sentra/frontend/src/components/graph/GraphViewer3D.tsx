"use client";

import dynamic from "next/dynamic";
import type { ComponentType, MutableRefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GraphSnapshot, ExplanationPayload } from "@/api/models";
import { ArrowLeftRight, Box, Info, Orbit, RotateCw } from "lucide-react";
import type { ForceGraphMethods } from "react-force-graph-3d";
import type { GraphMode, GraphViewerLink, GraphViewerNode } from "./graphTypes";
import { buildGraphViewerData, buildNodeSelection, getDebugFallbackData } from "./graphAdapter";

type ForceGraphBoundaryProps = Record<string, unknown> & {
  ref?: MutableRefObject<ForceGraphMethods | null>;
};

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false }) as unknown as ComponentType<ForceGraphBoundaryProps>;
const ENABLE_GRAPH_DEBUG = process.env.NEXT_PUBLIC_ENABLE_GRAPH_DEBUG === "true";
const CATEGORY_LEGEND = [
  { label: "State", color: "#c92a2a" },
  { label: "Trigger", color: "#d97706" },
  { label: "Behavior", color: "#6f42c1" },
  { label: "Event", color: "#0072b2" },
  { label: "Protective", color: "#2f9e44" },
];

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
  const [graphWidth, setGraphWidth] = useState(900);
  const fgRef = useRef<ForceGraphMethods | null>(null);
  const graphFrameRef = useRef<HTMLDivElement | null>(null);

  const orderedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => `${a.day}`.localeCompare(`${b.day}`)),
    [snapshots],
  );

  const activeSnapshot = currentSnapshot ?? orderedSnapshots.at(-1) ?? null;

  useEffect(() => {
    const frame = graphFrameRef.current;
    if (!frame) return;

    const updateWidth = () => {
      setGraphWidth(Math.max(320, Math.floor(frame.getBoundingClientRect().width)));
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

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

  const overlayNodes = useMemo(() => {
    return graphData.nodes.map((node, index) => {
      return {
        node,
        x: 50 + node.x * 0.38 + (index % 2) * 0.8,
        y: 50 + node.y * 0.38,
      };
    });
  }, [graphData.nodes]);

  const overlayNodeMap = useMemo(
    () => new Map(overlayNodes.map((item) => [`${item.node.snapshotId}:${item.node.originalId}`, item])),
    [overlayNodes],
  );

  const baselineSnapshot = orderedSnapshots.length > 1 ? orderedSnapshots[0] : null;
  const categoryCounts = useMemo(
    () => CATEGORY_LEGEND.map((category) => ({
      ...category,
      count: graphData.nodes.filter((node) => node.category === category.label).length,
    })),
    [graphData.nodes],
  );
  const modelLabel = activeSnapshot?.extraction_model && activeSnapshot.extraction_model !== "unknown"
    ? `${activeSnapshot.extraction_provider ?? "unknown"} / ${activeSnapshot.extraction_model}`
    : "model unknown";
  const temporalLabel =
    mode === "temporal" && baselineSnapshot && activeSnapshot
      ? `${baselineSnapshot.day} → ${activeSnapshot.day}`
      : activeSnapshot
        ? `${activeSnapshot.day}`
        : "No snapshots available";

  const createNodeObject = (node: GraphViewerNode) => {
    const group = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(node.radius, 32, 24),
      new THREE.MeshPhysicalMaterial({
        color: node.color,
        roughness: 0.38,
        metalness: 0.12,
        clearcoat: 0.6,
        clearcoatRoughness: 0.24,
      }),
    );
    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(node.radius * 1.18, 24, 18),
      new THREE.MeshBasicMaterial({
        color: node.color,
        transparent: true,
        opacity: node.sourceKind === "historical" ? 0.12 : 0.18,
        side: THREE.BackSide,
      }),
    );

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = "600 34px Arial";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "rgba(255,255,255,0.94)";
      context.strokeStyle = "rgba(15,23,42,0.18)";
      context.lineWidth = 2;
      context.roundRect(18, 26, 476, 72, 16);
      context.fill();
      context.stroke();
      context.fillStyle = "#0f172a";
      const label = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
      context.fillText(label, 256, 62);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    label.position.set(0, node.radius + 10, 0);
    label.scale.set(46, 12, 1);

    group.add(outline);
    group.add(sphere);
    group.add(label);
    return group;
  };

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            <Orbit className="h-4 w-4 text-cyan-600" />
            {title}
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">Interactive 3D structural graph</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Live extracted nodes are plotted as a labeled 3D structure. Color encodes ontology class, arrowed edges encode relation type, and temporal mode stacks real snapshots by date.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-1">
          {ENABLE_GRAPH_DEBUG && (
            <button
              type="button"
              onClick={() => setShowFallback(!showFallback)}
              className={`rounded px-3 py-2 text-sm font-medium transition ${
                showFallback ? "bg-rose-500 text-white" : "text-slate-600 hover:bg-white"
              }`}
            >
              {showFallback ? "Hide Fallback" : "Debug Fallback"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("current")}
            className={`rounded px-3 py-2 text-sm font-medium transition ${
              mode === "current" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
            }`}
          >
            Current
          </button>
          <button
            type="button"
            onClick={() => setMode("temporal")}
            className={`rounded px-3 py-2 text-sm font-medium transition ${
              mode === "temporal" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
            }`}
          >
            Temporal
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
        <span className="rounded border border-slate-200 bg-white px-3 py-1">Mode: {mode}</span>
        <span className="rounded border border-slate-200 bg-white px-3 py-1">Layer view: {temporalLabel}</span>
        <span className="rounded border border-slate-200 bg-white px-3 py-1">{graphData.nodes.length} nodes / {graphData.links.length} relations</span>
        <span className="rounded border border-slate-200 bg-white px-3 py-1">{modelLabel}</span>
      </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.35fr)_360px]">
        <div className="relative min-h-[680px] overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]">
          <div className="pointer-events-none absolute inset-0 opacity-[0.58] [background-image:linear-gradient(#dbe3ed_1px,transparent_1px),linear-gradient(90deg,#dbe3ed_1px,transparent_1px)] [background-size:42px_42px]" />
          <div className="pointer-events-none absolute left-5 top-5 z-10 rounded border border-slate-200 bg-white/88 px-3 py-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
            Graph3D projection · orbit / zoom / click nodes
          </div>
          <div ref={graphFrameRef} className="h-[680px] w-full">
            {graphData.nodes.length > 0 ? (
              <ForceGraph3D
                ref={fgRef}
                graphData={graphData}
                backgroundColor="rgba(255,255,255,0)"
                nodeLabel={(node: GraphViewerNode) =>
                  `${node.label} · ${node.category} · ${node.snapshotDay}${node.layerIndex >= 0 ? ` · layer ${node.layerIndex + 1}` : ""}`
                }
                nodeThreeObject={createNodeObject}
                nodeThreeObjectExtend={false}
                nodeColor={(node: GraphViewerNode) => node.color}
                nodeVal={(node: GraphViewerNode) => node.radius * 10}
                linkColor={(link: GraphViewerLink) => link.color}
                linkWidth={(link: GraphViewerLink) => link.width * 0.9}
                linkOpacity={0.72}
                linkDirectionalArrowLength={(link: GraphViewerLink) => (link.type === "buffers" ? 2 : 5)}
                linkDirectionalArrowRelPos={0.92}
                linkDirectionalParticles={2}
                linkDirectionalParticleWidth={(link: GraphViewerLink) => Math.max(1.4, link.width * 0.7)}
                linkDirectionalParticleSpeed={0.006}
                linkCurvature={(link: GraphViewerLink) => (link.dashed ? 0.16 : 0.06)}
                nodeRelSize={9}
                enableNodeDrag={true}
                onNodeClick={(node: GraphViewerNode) => setSelectedNode(node)}
                onBackgroundClick={() => setSelectedNode(null)}
                controlType="orbit"
                warmupTicks={80}
                cooldownTicks={100}
                showNavInfo={false}
                width={graphWidth}
                height={680}
                onEngineStop={() => {
                  if (!fgRef.current) return;
                  fgRef.current.cameraPosition({ x: 0, y: 0, z: 240 }, { x: 0, y: 0, z: 0 }, 600);
                  fgRef.current.zoomToFit(900, 96);
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-sm text-slate-300">
                No graph data yet. Submit a journal entry with events, supports, stressors, or changes to render the structural graph.
              </div>
            )}
          </div>
          {graphData.nodes.length > 0 && (
            <svg
              className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="graphBasisFade" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#f8fafc" stopOpacity="0" />
                  <stop offset="100%" stopColor="#f8fafc" stopOpacity="0.9" />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width="100" height="100" fill="url(#graphBasisFade)" />
              {graphData.links.map((link, index) => {
                const source = typeof link.source === "string" ? null : overlayNodeMap.get(`${link.source.snapshotId}:${link.source.originalId}`);
                const target = typeof link.target === "string" ? null : overlayNodeMap.get(`${link.target.snapshotId}:${link.target.originalId}`);
                if (!source || !target) return null;
                return (
                  <line
                    key={`${link.snapshotId}-${link.source_id}-${link.target_id}-${link.type}-${index}`}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    stroke={link.color}
                    strokeWidth={0.18}
                    strokeOpacity={0.32}
                  />
                );
              })}
              {overlayNodes.map(({ node, x, y }) => (
                <g key={`${node.snapshotId}-${node.originalId}`}>
                  <circle cx={x} cy={y} r={1.1 + node.radius * 0.06} fill={node.color} opacity={0.7} />
                </g>
              ))}
            </svg>
          )}
        </div>

        <aside className="space-y-4 border-l border-slate-200 bg-slate-50 p-5">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <ArrowLeftRight className="h-4 w-4 text-cyan-600" />
              Baseline vs current
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              <div>Snapshots: {orderedSnapshots.length}</div>
              <div>Baseline layer: {baselineSnapshot?.day ?? "n/a"}</div>
              <div>Current layer: {activeSnapshot?.day ?? "n/a"}</div>
              <div>Source: {usingFallback ? "debug fallback" : "live snapshots"}</div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <Box className="h-4 w-4 text-cyan-600" />
              Ontology basis
            </div>
            <div className="mt-4 space-y-3">
              {categoryCounts.map((item) => (
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
              ))}
            </div>
          </div>

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
                <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
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

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              <RotateCw className="h-4 w-4 text-cyan-600" />
              How to read this
            </div>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p>Node color encodes ontology class.</p>
              <p>Relation styling encodes relation type.</p>
              <p>Temporal mode stacks snapshots on the z-axis so shifts across time are visible.</p>
              <p>White canvas, labels, arrows, and basis markers are tuned for inspection rather than presentation-only decoration.</p>
              {usingFallback && <p className="text-rose-600">Debug fallback is active.</p>}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
