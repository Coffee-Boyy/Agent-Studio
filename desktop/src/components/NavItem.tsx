export function NavItem(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`asNavItem ${props.active ? "active" : ""}`} onClick={props.onClick} type="button">
      {props.label}
    </button>
  );
}