import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

// Paleta categórica equivalente ao "set3" do d3/nivo, usada antes.
const CORES_SET3 = [
  "#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462",
  "#b3de69", "#fccde5", "#d9d9d9", "#bc80bd", "#ccebc5", "#ffed6f",
];

export function RankingPieChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div style={{ height: 400 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="45%"
            outerRadius="75%"
            paddingAngle={1.5}
            stroke="var(--sys-color-surface, #fff)"
            strokeWidth={1}
            label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
            labelLine={{ stroke: "var(--sys-color-text-muted, #333333)" }}
          >
            {data.map((entry, i) => (
              <Cell key={entry.name} fill={CORES_SET3[i % CORES_SET3.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "var(--sys-color-surface, #fff)",
              color: "var(--sys-color-text-main, #1C1D26)",
              border: "none",
              borderRadius: 8,
            }}
          />
          <Legend wrapperStyle={{ color: "var(--sys-color-text-muted, #5A5C6E)", fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
