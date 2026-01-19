export function Card(props: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="asCard">
      {props.title ? (
        <header className="asCardHeader">
          <div className="asCardTitle">{props.title}</div>
          {props.right ? <div className="asCardRight">{props.right}</div> : null}
        </header>
      ) : null}
      <div className="asCardBody">{props.children}</div>
    </section>
  );
}