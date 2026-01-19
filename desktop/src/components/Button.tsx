export function Button(props: {
  tone?: "primary" | "neutral" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  type?: "button" | "submit";
}) {
  return (
    <button className={`asBtn ${props.tone ?? "neutral"}`} disabled={props.disabled} onClick={props.onClick} type={props.type ?? "button"}>
      {props.children}
    </button>
  );
}