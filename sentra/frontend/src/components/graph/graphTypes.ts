import type { ExtractionNode, ExtractionRelation, GraphSnapshot, ExplanationPayload, RecordId } from "@/api/models";

export type GraphMode = "current" | "temporal";

export interface GraphViewerNode extends ExtractionNode {
  originalId: string;
  snapshotId: RecordId;
  snapshotDay: string;
  layerIndex: number;
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  color: string;
  radius: number;
  sourceKind: "current" | "historical";
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
