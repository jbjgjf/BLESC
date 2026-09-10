"use client";

/**
 * One participant's observed history and the forecast that follows it.
 *
 * Observation, post-cutoff actual and prediction are three separate series.
 * Drawing them as one continuous line would hide the cutoff, and the cutoff is
 * the only thing that makes the rest of the chart interpretable: everything left
 * of it is data the model had, everything right of it is data it did not.
 *
 * The shaded band is the model's own residual spread from validation, not a
 * calibrated interval. It is labelled that way, and the coverage number in the
 * report is what says whether to believe it.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { t } from "@/lib/i18n";
import { type ForecastPreview, seriesForFeature } from "@/lib/research/worldModel";

function dayLabel(iso: string): string {
  return iso.slice(5, 10);
}

export function ForecastChart({
  preview,
  featureIndex,
}: {
  preview: ForecastPreview | null;
  featureIndex: number;
}) {
  if (!preview) return <p>{t.worldModel.noPreview}</p>;

  const rows = seriesForFeature(preview, featureIndex).map((row) => ({
    ...row,
    label: dayLabel(row.at),
    band:
      row.lower !== null && row.upper !== null ? [row.lower, row.upper] : undefined,
  }));

  return (
    <div>
      <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>
        {t.worldModel.featureLabel(preview.feature_names[featureIndex] ?? "")}
      </h3>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={48} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
            <ReferenceLine x={dayLabel(preview.cutoff_at)} stroke="hsl(0, 0%, 45%)" />
            <Area
              dataKey="band"
              stroke="none"
              fill="hsla(258, 65%, 60%, 0.18)"
              isAnimationActive={false}
              legendType="none"
            />
            <Line
              type="monotone"
              dataKey="observed"
              name={t.worldModel.timeseriesLegend.observed}
              stroke="hsl(210, 60%, 40%)"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Scatter
              dataKey="actual"
              name={t.worldModel.timeseriesLegend.actual}
              fill="hsl(210, 60%, 40%)"
            />
            <Line
              type="monotone"
              dataKey="forecast"
              name={t.worldModel.timeseriesLegend.forecast}
              stroke="hsl(258, 65%, 50%)"
              strokeDasharray="5 4"
              dot
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="baseline"
              name={t.worldModel.timeseriesLegend.baseline}
              stroke="hsl(38, 85%, 42%)"
              strokeDasharray="2 4"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p style={{ fontSize: "0.8rem", opacity: 0.75 }}>{t.worldModel.timeseriesNote}</p>
    </div>
  );
}
