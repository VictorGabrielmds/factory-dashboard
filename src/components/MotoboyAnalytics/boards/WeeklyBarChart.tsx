import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "../MotoboyAnalytics.css";

export function WeeklyBarChart({ data }: { data: { dia: string; entregas: number }[] }) {
  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 30, bottom: 10, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--sys-color-line, #E8E9F1)" />
          <XAxis
            dataKey="dia"
            tick={{ fill: "var(--sys-color-text-faint, #9A9CB0)", fontSize: 12 }}
            axisLine={{ stroke: "var(--sys-color-line, #E8E9F1)" }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: "var(--sys-color-text-faint, #9A9CB0)", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "var(--sys-color-line, #E8E9F1)", opacity: 0.4 }}
            contentStyle={{
              background: "var(--sys-color-surface, #fff)",
              color: "var(--sys-color-text-main, #1C1D26)",
              border: "none",
              borderRadius: 8,
            }}
          />
          <Bar dataKey="entregas" name="Entregas" fill="#0fa7df" radius={[4, 4, 0, 0]}>
            <LabelList dataKey="entregas" position="top" fill="var(--sys-color-text-muted, #5A5C6E)" fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
