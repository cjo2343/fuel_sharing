// VehloShare logo — drop-in React component. No external assets required.
//
//   <Logo />                         primary lockup, 40px tall
//   <Logo variant="icon" height={64} />
//   <Logo variant="reversed" />      white mark for dark/forest backgrounds
//   <Logo variant="lockup-reversed" />
//
// The wordmark needs the Nunito font loaded in the host app.

const MARK = `
  <circle cx="38" cy="82" r="11" fill="#1A2E1F"/><circle cx="38" cy="82" r="3.6" fill="#D8F3DC"/>
  <circle cx="82" cy="82" r="11" fill="#1A2E1F"/><circle cx="82" cy="82" r="3.6" fill="#D8F3DC"/>
  <rect x="8" y="46" width="104" height="34" rx="17" fill="#2D6A4F"/>
  <circle cx="107" cy="60" r="4" fill="#F4A261"/>
  <circle cx="48" cy="34" r="18" fill="#52B788"/><circle cx="76" cy="34" r="18" fill="#D8F3DC"/>
  <circle cx="43" cy="32" r="2.3" fill="#1A2E1F"/><circle cx="53" cy="32" r="2.3" fill="#1A2E1F"/>
  <path d="M43 38 Q48 43 53 38" fill="none" stroke="#1A2E1F" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="71" cy="32" r="2.3" fill="#1A2E1F"/><circle cx="81" cy="32" r="2.3" fill="#1A2E1F"/>
  <path d="M71 38 Q76 43 81 38" fill="none" stroke="#1A2E1F" stroke-width="2.4" stroke-linecap="round"/>`;

const MARK_REVERSED = `
  <circle cx="38" cy="82" r="11" fill="#1A2E1F"/><circle cx="38" cy="82" r="3.6" fill="#fff"/>
  <circle cx="82" cy="82" r="11" fill="#1A2E1F"/><circle cx="82" cy="82" r="3.6" fill="#fff"/>
  <rect x="8" y="46" width="104" height="34" rx="17" fill="#F7F9F8"/>
  <circle cx="107" cy="60" r="4" fill="#F4A261"/>
  <circle cx="48" cy="34" r="18" fill="#52B788"/><circle cx="76" cy="34" r="18" fill="#fff"/>
  <circle cx="43" cy="32" r="2.3" fill="#1A2E1F"/><circle cx="53" cy="32" r="2.3" fill="#1A2E1F"/>
  <path d="M43 38 Q48 43 53 38" fill="none" stroke="#1A2E1F" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="71" cy="32" r="2.3" fill="#1A2E1F"/><circle cx="81" cy="32" r="2.3" fill="#1A2E1F"/>
  <path d="M71 38 Q76 43 81 38" fill="none" stroke="#1A2E1F" stroke-width="2.4" stroke-linecap="round"/>`;

export function Logo({ variant = "lockup", height = 40, ...rest }) {
  const reversed = variant.includes("reversed");
  const iconOnly = variant === "icon" || variant === "reversed";
  const Icon = (
    <svg
      width={height * 1.2}
      height={height}
      viewBox="0 0 120 100"
      dangerouslySetInnerHTML={{ __html: reversed ? MARK_REVERSED : MARK }}
    />
  );
  if (iconOnly) return <span {...rest}>{Icon}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: height * 0.22 }} {...rest}>
      {Icon}
      <span
        style={{
          fontFamily: "Nunito, sans-serif",
          fontWeight: 900,
          fontSize: height * 0.72,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          color: reversed ? "#fff" : "#1A2E1F",
        }}
      >
        Vehlo<span style={{ color: reversed ? "#52B788" : "#2D6A4F" }}>Share</span>
      </span>
    </span>
  );
}

export default Logo;
