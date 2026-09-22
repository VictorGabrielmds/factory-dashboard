import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface HourlyChartProps {
  data: { hora: string; quantidade: number }[];
}

export const HourlyChart: React.FC<HourlyChartProps> = ({ data }) => {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="colorPedidos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8}/>
            <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
        <XAxis 
          dataKey="hora" 
          tick={{ fontSize: 12 }} 
          interval={2} // Mostra a hora a cada 2 intervalos para não poluir
        />
        <YAxis allowDecimals={false} />
        <Tooltip 
          contentStyle={{ backgroundColor: "#333", border: "none", borderRadius: "8px", color: "#fff" }}
        />
        <Area 
          type="monotone" 
          dataKey="quantidade" 
          stroke="#8884d8" 
          fillOpacity={1} 
          fill="url(#colorPedidos)" 
          name="Pedidos"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};