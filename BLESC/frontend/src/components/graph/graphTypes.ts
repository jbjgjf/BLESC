import type { ExtractionNode, ExtractionRelation, GraphSnapshot, ExplanationPayload, RecordId } from "@/api/models";

export type GraphMode = "current" | "temporal" | "concept";

export interface GraphViewerNode extends ExtractionNode {
  originalId: string;
  snapshotId: RecordId;
  snapshotDay: string;
  layerIndex: number;
  x: number;
  y: number;
  z: number;
  // undefined = let force simulation position freely; number = pin to that coordinate
  fx?: number;
  fy?: number;
  fz?: number;
  color: string;
  radius: number;
  sourceKind: "current" | "historical";
  // concept graph extras
  frequency?: number;
  allDays?: string[];
}

export interface GraphViewerLink extends ExtractionRelation {
  source: string | GraphViewerNode;
  target: string | GraphViewerNode;
  color: string;
  width: number;
  opacity: number;
  dashed: boolean;
  layerIndex: number;
  snapshotId: RecordId;
  snapshotDay: string;
  frequency?: number;
}

export interface GraphViewerData {
  nodes: GraphViewerNode[];
  links: GraphViewerLink[];
}

export interface GraphNodeSelection {
  node: GraphViewerNode;
  roleSummary: string;
  relationSummary: string[];
  anomalySignals: string[];
}

export interface GraphViewerProps {
  snapshots: GraphSnapshot[];
  currentSnapshot?: GraphSnapshot | null;
  explanation?: ExplanationPayload | null;
  title?: string;
}
