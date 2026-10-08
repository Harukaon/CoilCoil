/** One collapsible block of the runtime panel: a title with an icon, an optional badge, and a body. */
export function RuntimeSection({
  title,
  icon,
  badge,
  children,
  open = false,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
}): React.JSX.Element {
  return (
    <details className="runtime-section" open={open}>
      <summary><span>{icon}<strong>{title}</strong></span>{badge ? <small>{badge}</small> : null}</summary>
      <div className="runtime-section-body">{children}</div>
    </details>
  );
}
