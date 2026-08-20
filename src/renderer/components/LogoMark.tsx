import logoUrl from "../assets/cli-cockpit-logo.svg";

interface LogoMarkProps {
  className?: string;
}

export function LogoMark({ className }: LogoMarkProps) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={["brand-mark", className].filter(Boolean).join(" ")}
      draggable={false}
      src={logoUrl}
    />
  );
}
