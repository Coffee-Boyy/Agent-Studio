export function Metric(props: { label: string; value: string }) {
  return (
    <div className="asMetric">
      <div className="asMetricLabel">{props.label}</div>
      <div className="asMetricValue">{props.value}</div>
    </div>
  );
}