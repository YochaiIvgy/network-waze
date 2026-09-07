/**
 * The 46c mark: red field, white numerals cropped by the right edge, black bar
 * across the foot. Rendered as SVG so it stays crisp and can be recoloured by
 * the theme (the foot bar inverts in dark mode via --bar).
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="46c"
      style={{ borderRadius: 7, display: "block", flex: "none" }}
    >
      <defs>
        <clipPath id="waze-logo-clip">
          <rect x="0" y="0" width="64" height="64" rx="7" />
        </clipPath>
      </defs>
      <g clipPath="url(#waze-logo-clip)">
        <rect x="0" y="0" width="64" height="64" fill="var(--brand)" />
        <text
          x="-2"
          y="45"
          fontFamily="var(--font)"
          fontSize="44"
          fontWeight="800"
          letterSpacing="-3"
          fill="#ffffff"
        >
          46
        </text>
        <rect x="0" y="50" width="64" height="14" fill="var(--bar)" />
      </g>
    </svg>
  );
}
